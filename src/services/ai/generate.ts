import {
  addCardsToDeck,
  updateDocumentSummary,
  type CardType,
  type DraftCard,
  type StudyDocument,
} from '@/lib/db';
import { chunkText } from '@/lib/text';
import { errorMessage } from '@/lib/utils';

import { llmEngine } from './engine';
import { EngineRuntimeError, GpuExhaustedError } from './errors';
import { buildCardGrammar, salvageTruncated, tokenBudget } from './grammar';
import { buildChunkPrompt, SYSTEM_PROMPT } from './prompt';
import { dedupeKey, parseGenerationResponse, type RejectionStats } from './schema';

export type GenerationPhase =
  /** Wczytywanie modelu do pamięci GPU. */
  | 'loading-model'
  /** Podział materiału na fragmenty. */
  | 'analyzing'
  /** Model pracuje nad kolejnymi fragmentami. */
  | 'generating'
  /** Zapis kompendium. */
  | 'saving'
  | 'done'
  | 'cancelled';

/** Kolejność etapów pokazywana użytkownikowi. */
export const GENERATION_PHASES: readonly GenerationPhase[] = [
  'loading-model',
  'analyzing',
  'generating',
  'saving',
] as const;

export const PHASE_LABELS: Record<GenerationPhase, string> = {
  'loading-model': 'Uruchamianie modelu',
  analyzing: 'Analiza materiału',
  generating: 'Tworzenie fiszek',
  saving: 'Zapisywanie kompendium',
  done: 'Gotowe',
  cancelled: 'Przerwano',
};

export interface GenerationProgress {
  phase: GenerationPhase;
  /** Numer przetwarzanego fragmentu (1-indeksowany, 0 przed startem). */
  chunkNumber: number;
  chunkCount: number;
  /** Liczba fiszek zapisanych do tej pory. */
  cardsGenerated: number;
  message: string;
  /** Fiszki z ostatnio przetworzonego fragmentu — podgląd na żywo. */
  newCards: DraftCard[];
  /** Czas od startu w ms. */
  elapsedMs: number;
  /** Szacowany czas do końca w ms; `null`, dopóki nie ma z czego liczyć. */
  etaMs: number | null;
}

export interface GenerationOptions {
  document: StudyDocument;
  deckId: number;
  /** Typy fiszek wybrane przez użytkownika (min. 1). */
  allowedTypes: readonly CardType[];
  /** Ile fiszek prosimy z jednego fragmentu materiału. */
  cardsPerChunk: number;
  /** Czy nadpisać istniejące kompendium dokumentu. */
  regenerateSummary: boolean;
  onProgress?: (progress: GenerationProgress) => void;
  signal?: AbortSignal;
}

export interface GenerationResult {
  cardsAdded: number;
  /** Ustawione, gdy przebieg przerwała awaria silnika. */
  fatalError: string | null;
  /** Fiszki odrzucone przez walidację (duplikaty, braki, brak cytatu). */
  rejected: number;
  /** Cytaty skorygowane do dosłownego fragmentu źródła. */
  correctedExcerpts: number;
  /** Fragmenty, których model nie przetworzył poprawnie. */
  failedChunks: number;
  /** Ile fiszek model w ogóle zwrócił przed walidacją. */
  returned: number;
  /** Rozbicie odrzuceń na przyczyny — klucz do zrozumienia wyniku „0 fiszek”. */
  rejections: RejectionStats;
  /** Cytaty przypisane zastępczo, bo model sparafrazował źródło. */
  unverifiedExcerpts: number;
  /** Odpowiedzi ucięte limitem tokenów, z których odzyskano kompletne fiszki. */
  truncatedResponses: number;
  /** Ile razy trzeba było wczytać model ponownie po ubiciu workera. */
  modelReloads: number;
  /**
   * Skrócona surowa odpowiedź modelu z pierwszego nieudanego fragmentu —
   * jedyny sposób, by zdiagnozować „zero fiszek” na cudzym urządzeniu.
   */
  debugSample: string | null;
  chunkCount: number;
  cancelled: boolean;
  summary: string;
}

/**
 * Rozmiar fragmentu materiału (znaki). Okno kontekstu to 4096 tokenów, a na
 * wejściu jest też prompt systemowy i instrukcja; na wyjściu budżet z gramatyki.
 * Na telefonie krótszy fragment = krótsze pojedyncze obciążenie GPU.
 */
const GENERATION_CHUNK_SIZE = 1800;
const MOBILE_CHUNK_SIZE = 1100;

/**
 * Ile razy pod rząd wolno odtworzyć silnik po jego awarii, zanim uznamy, że
 * urządzenie nie utrzyma modelu. Licznik zeruje każdy udany fragment.
 */
const MAX_RECOVERIES_IN_A_ROW = 2;

/**
 * Worker z modelem bywa ubijany przez system (utrata urządzenia GPU). Poza
 * błędem samego silnika (`EngineRuntimeError`) objawia się też tym, że silnik
 * nie ma już modelu.
 */
function isModelUnloadedError(message: string): boolean {
  return /modelnotloadederror|model not loaded|nie jest wczytany|been disposed/i.test(message);
}

/**
 * Czy po błędzie warto odtworzyć silnik. Każdy błąd rzucony przez silnik w
 * trakcie generowania traktujemy jako możliwą utratę GPU (komunikaty bywają
 * różne: „map async was not successful”, „already been disposed”…) — poza
 * błędami deterministycznymi (gramatyka, przepełnienie kontekstu), które
 * powtórzyłyby się po każdym przeładowaniu.
 */
export function isRecoverableEngineError(error: unknown): boolean {
  if (error instanceof GpuExhaustedError) return false;
  const message = errorMessage(error);
  if (/grammar|context window|context_window|exceed/i.test(message)) return false;
  return error instanceof EngineRuntimeError || isModelUnloadedError(message);
}

/**
 * Główny potok generowania: dzieli materiał na fragmenty, dla każdego prosi
 * model o fiszki + kompendium (w formacie wymuszonym gramatyką), waliduje wynik
 * i zapisuje go w IndexedDB od razu po każdym fragmencie.
 */
export async function generateFromDocument(options: GenerationOptions): Promise<GenerationResult> {
  const { document, deckId, allowedTypes, cardsPerChunk, signal } = options;
  const report = (progress: GenerationProgress): void => options.onProgress?.(progress);

  if (allowedTypes.length === 0) {
    throw new Error('Wybierz przynajmniej jeden typ fiszek.');
  }

  const startedAt = Date.now();
  const chunkDurations: number[] = [];

  /** Średni czas fragmentu × pozostałe fragmenty. */
  const estimateRemaining = (done: number, total: number): number | null => {
    if (chunkDurations.length === 0) return null;
    const average = chunkDurations.reduce((sum, value) => sum + value, 0) / chunkDurations.length;
    return Math.max(0, Math.round(average * (total - done)));
  };

  report({
    phase: 'analyzing',
    chunkNumber: 0,
    chunkCount: 0,
    cardsGenerated: 0,
    message: 'Dzielenie materiału na fragmenty…',
    newCards: [],
    elapsedMs: 0,
    etaMs: null,
  });

  const isMobile = llmEngine.getState().profile.isMobile;
  const chunks = chunkText(document.rawContent, isMobile ? MOBILE_CHUNK_SIZE : GENERATION_CHUNK_SIZE);
  if (chunks.length === 0) {
    throw new Error('Materiał jest pusty — dodaj treść, z której mają powstać fiszki.');
  }

  const grammar = buildCardGrammar(allowedTypes, cardsPerChunk);
  const maxTokens = tokenBudget(cardsPerChunk);
  const seenFronts = new Set<string>();
  const summaries: string[] = [];
  const rejections: RejectionStats = { incomplete: 0, duplicate: 0, ungrounded: 0 };

  let cardsAdded = 0;
  let rejected = 0;
  let correctedExcerpts = 0;
  let unverifiedExcerpts = 0;
  let returned = 0;
  let failedChunks = 0;
  let truncatedResponses = 0;
  let modelReloads = 0;
  let recoveriesInARow = 0;
  let processedChunks = 0;
  let cancelled = false;
  let fatalError: string | null = null;
  let debugSample: string | null = null;

  // Czytamy flagę przez funkcję — inaczej analiza przepływu TS „zamraża”
  // wartość `aborted` z pierwszego sprawdzenia w pętli.
  const isAborted = (): boolean => signal?.aborted === true;

  /**
   * Zapytanie do modelu z odtwarzaniem silnika: po awarii GPU wczytujemy model
   * w nowym workerze (stary jest najpierw zwalniany) i powtarzamy fragment.
   */
  const askModel = async (
    request: Parameters<typeof llmEngine.generateJson>[0],
    chunkNumber: number,
  ): Promise<Awaited<ReturnType<typeof llmEngine.generateJson>>> => {
    for (;;) {
      try {
        return await llmEngine.generateJson(request);
      } catch (error) {
        if (isAborted() || !isRecoverableEngineError(error)) throw error;
        if (recoveriesInARow >= MAX_RECOVERIES_IN_A_ROW) {
          throw new GpuExhaustedError(errorMessage(error), modelReloads);
        }
        modelReloads += 1;
        recoveriesInARow += 1;
        report({
          phase: 'loading-model',
          chunkNumber,
          chunkCount: chunks.length,
          cardsGenerated: cardsAdded,
          message: `Silnik przerwał pracę (${errorMessage(error).slice(0, 80)}) — uruchamiam go ponownie…`,
          newCards: [],
          elapsedMs: Date.now() - startedAt,
          etaMs: null,
        });
        // `recover()`, nie `load()` — ten drugi uznałby, że model wciąż jest gotowy.
        try {
          await llmEngine.recover({ hard: true });
        } catch (reloadError) {
          // Model nie wczytał się ponownie — dalsze fragmenty nie mają szans.
          throw new EngineRuntimeError(`Nie udało się ponownie wczytać modelu: ${errorMessage(reloadError)}`);
        }
      }
    }
  };

  // Przerwanie generowania: zatrzymujemy dekodowanie w workerze od razu.
  const onAbort = (): void => llmEngine.interrupt();
  signal?.addEventListener('abort', onAbort);

  try {
    for (const chunk of chunks) {
      if (isAborted()) {
        cancelled = true;
        break;
      }

      const chunkNumber = chunk.index + 1;
      const chunkStartedAt = Date.now();
      processedChunks = chunkNumber;
      report({
        phase: 'generating',
        chunkNumber,
        chunkCount: chunks.length,
        cardsGenerated: cardsAdded,
        message: `Fragment ${chunkNumber} z ${chunks.length} — model pracuje lokalnie…`,
        newCards: [],
        elapsedMs: Date.now() - startedAt,
        etaMs: estimateRemaining(chunk.index, chunks.length),
      });

      let raw = '';
      try {
        const response = await askModel(
          {
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              {
                role: 'user',
                content: buildChunkPrompt({
                  documentTitle: document.title,
                  chunk: chunk.content,
                  chunkNumber,
                  chunkCount: chunks.length,
                  targetCards: cardsPerChunk,
                  allowedTypes,
                }),
              },
            ],
            grammar,
            maxTokens,
            temperature: 0.3,
          },
          chunkNumber,
        );
        raw = response.content;

        // Ucięte limitem tokenów: zachowujemy fiszki, które zdążyły się domknąć.
        if (response.finishReason === 'length') {
          const salvaged = salvageTruncated(raw);
          if (salvaged === null) throw new Error('Odpowiedź ucięta przed pierwszą kompletną fiszką.');
          raw = salvaged;
          truncatedResponses += 1;
        }

        const parsed = parseGenerationResponse(raw, { source: chunk.content, allowedTypes, seenFronts });
        if (parsed.cards.length === 0 && debugSample === null) {
          debugSample = `[fragment ${chunkNumber}] ${raw.slice(0, 700)}`;
        }

        if (parsed.summary.length > 0) summaries.push(parsed.summary.trim());
        rejected += parsed.rejected;
        correctedExcerpts += parsed.correctedExcerpts;
        unverifiedExcerpts += parsed.unverifiedExcerpts;
        returned += parsed.returned;
        rejections.incomplete += parsed.rejections.incomplete;
        rejections.duplicate += parsed.rejections.duplicate;
        rejections.ungrounded += parsed.rejections.ungrounded;

        // Zapis po każdym fragmencie: przerwanie lub awaria nie kasuje pracy modelu.
        const addedNow = await addCardsToDeck(deckId, parsed.cards);
        cardsAdded += addedNow;
        recoveriesInARow = 0;
        chunkDurations.push(Date.now() - chunkStartedAt);

        report({
          phase: 'generating',
          chunkNumber,
          chunkCount: chunks.length,
          cardsGenerated: cardsAdded,
          message: `Fragment ${chunkNumber} z ${chunks.length} — dodano ${addedNow} fiszek.`,
          newCards: parsed.cards,
          elapsedMs: Date.now() - startedAt,
          etaMs: estimateRemaining(chunkNumber, chunks.length),
        });
      } catch (error) {
        if (isAborted()) {
          cancelled = true;
          break;
        }

        const message = errorMessage(error);
        failedChunks += 1;
        console.warn(`[CognitiveDeck] Fragment ${chunkNumber} nie został przetworzony: ${message}`);
        debugSample ??= `[fragment ${chunkNumber}] ${message}${raw.length > 0 ? ` || ${raw.slice(0, 600)}` : ''}`;

        // Błąd silnika, którego nie naprawiło odtworzenie (albo deterministyczny,
        // jak przepełnienie kontekstu) — kolejne fragmenty skończyłyby się tak samo.
        if (error instanceof GpuExhaustedError || error instanceof EngineRuntimeError) {
          fatalError = message;
          break;
        }
        // Pojedynczy nieczytelny wynik — przechodzimy do następnego fragmentu.
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  report({
    phase: 'saving',
    chunkNumber: processedChunks,
    chunkCount: chunks.length,
    cardsGenerated: cardsAdded,
    message: 'Zapisywanie kompendium…',
    newCards: [],
    elapsedMs: Date.now() - startedAt,
    etaMs: 0,
  });

  const summary = composeSummary(document, summaries);
  const shouldWriteSummary =
    summaries.length > 0 && (options.regenerateSummary || document.structuredSummary.length === 0);
  if (shouldWriteSummary) {
    await updateDocumentSummary(document.id, summary);
  }

  report({
    phase: cancelled ? 'cancelled' : 'done',
    chunkNumber: processedChunks,
    chunkCount: chunks.length,
    cardsGenerated: cardsAdded,
    message: cancelled ? 'Przerwano — zapisano dotychczasowe fiszki.' : 'Gotowe.',
    newCards: [],
    elapsedMs: Date.now() - startedAt,
    etaMs: 0,
  });

  // Po awarii silnika zwalniamy model — kolejna próba wystartuje na czystym GPU.
  if (fatalError !== null) {
    await llmEngine.unload().catch(() => undefined);
  }

  return {
    cardsAdded,
    fatalError,
    truncatedResponses,
    modelReloads,
    debugSample,
    returned,
    rejections,
    unverifiedExcerpts,
    rejected,
    correctedExcerpts,
    failedChunks,
    chunkCount: chunks.length,
    cancelled,
    summary: shouldWriteSummary ? summary : document.structuredSummary,
  };
}

/** Składa kompendium całego dokumentu z podsumowań poszczególnych fragmentów. */
export function composeSummary(document: StudyDocument, sections: string[]): string {
  if (sections.length === 0) return document.structuredSummary;
  const header = `# Kompendium: ${document.title}`;
  const note = '> Opracowane lokalnie na Twoim urządzeniu na podstawie materiału źródłowego.';
  return [header, note, ...sections].join('\n\n');
}

/** Pomocnik dla ręcznego dodawania fiszki — te same reguły deduplikacji. */
export function draftKey(draft: DraftCard): string {
  return dedupeKey(draft.front);
}
