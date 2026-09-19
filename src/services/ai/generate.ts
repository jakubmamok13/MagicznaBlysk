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
import { buildChunkPrompt, SYSTEM_PROMPT } from './prompt';
import {
  buildGenerationSchema,
  dedupeKey,
  parseGenerationResponse,
  type RejectionStats,
} from './schema';

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
  chunkCount: number;
  cancelled: boolean;
  summary: string;
}

/**
 * Okno kontekstu modeli to 4096 tokenów, a polszczyzna tokenizuje się gęściej
 * niż angielski. Trzymamy więc zapas: mniejszy fragment na wejściu i budżet
 * wyjścia dobrany do liczby zamawianych fiszek. Przekroczenie okna kończyło się
 * awarią silnika w trakcie „tworzenia fiszek”.
 */
const GENERATION_CHUNK_SIZE = 1800;

function outputTokenBudget(cardsPerChunk: number): number {
  return Math.min(1400, Math.max(600, 400 + 160 * cardsPerChunk));
}

/** Po tylu błędach pod rząd przerywamy — coś jest nie tak systemowo. */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Błędy, po których silnik nie nadaje się do dalszej pracy: utrata urządzenia
 * GPU, brak pamięci, przepełnienie kontekstu. Dalsze fragmenty i tak poległyby
 * tak samo, więc przerywamy od razu zamiast mielić kilka minut.
 */
export function isFatalEngineError(message: string): boolean {
  return /device lost|out of memory|\boom\b|context window|exceed|webgpu|adapter|destroyed|detached|aborted\(\)|unreachable/i.test(
    message,
  );
}

/**
 * Główny potok generowania: dzieli materiał na fragmenty, dla każdego prosi
 * model o kompendium + atomowe fiszki, waliduje wynik i zapisuje w IndexedDB.
 *
 * Cała operacja jest odporna na błąd pojedynczego fragmentu — pozostałe
 * fragmenty są przetwarzane dalej, a wynik raportuje liczbę niepowodzeń.
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

  const chunks = chunkText(document.rawContent, GENERATION_CHUNK_SIZE);
  if (chunks.length === 0) {
    throw new Error('Materiał jest pusty — dodaj treść, z której mają powstać fiszki.');
  }

  const schema = buildGenerationSchema(allowedTypes);
  const seenFronts = new Set<string>();
  const summaries: string[] = [];

  let cardsAdded = 0;
  let rejected = 0;
  let correctedExcerpts = 0;
  let failedChunks = 0;
  let cancelled = false;
  let consecutiveFailures = 0;
  let fatalError: string | null = null;
  let returned = 0;
  let unverifiedExcerpts = 0;
  const rejections: RejectionStats = { incomplete: 0, duplicate: 0, ungrounded: 0 };

  // Czytamy flagę przez funkcję — inaczej analiza przepływu TS „zamraża”
  // wartość `aborted` z pierwszego sprawdzenia w pętli.
  const isAborted = (): boolean => signal?.aborted === true;

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

      try {
        const raw = await llmEngine.generateJson({
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
          schema,
          maxTokens: outputTokenBudget(cardsPerChunk),
          temperature: 0.3,
        });

        const parsed = parseGenerationResponse(raw, {
          source: chunk.content,
          allowedTypes,
          seenFronts,
        });

        if (parsed.summary.length > 0) summaries.push(parsed.summary.trim());
        rejected += parsed.rejected;
        correctedExcerpts += parsed.correctedExcerpts;
        unverifiedExcerpts += parsed.unverifiedExcerpts;
        returned += parsed.returned;
        rejections.incomplete += parsed.rejections.incomplete;
        rejections.duplicate += parsed.rejections.duplicate;
        rejections.ungrounded += parsed.rejections.ungrounded;

        /**
         * Zapisujemy po każdym fragmencie, a nie na końcu: fiszki pojawiają się
         * na liście od razu, a przerwanie lub awaria przeglądarki nie kasuje
         * dotychczasowej pracy modelu.
         */
        const addedNow = await addCardsToDeck(deckId, parsed.cards);
        cardsAdded += addedNow;
        consecutiveFailures = 0;
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
        consecutiveFailures += 1;
        console.warn(`[CognitiveDeck] Fragment ${chunkNumber} nie został przetworzony: ${message}`);

        if (isFatalEngineError(message)) {
          fatalError = message;
          break;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          fatalError = `Model zwrócił błąd przy ${consecutiveFailures} fragmentach pod rząd: ${message}`;
          break;
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  report({
    phase: 'saving',
    chunkNumber: chunks.length,
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
    chunkNumber: chunks.length,
    chunkCount: chunks.length,
    cardsGenerated: cardsAdded,
    message: cancelled ? 'Przerwano — zapisano dotychczasowe fiszki.' : 'Gotowe.',
    newCards: [],
    elapsedMs: Date.now() - startedAt,
    etaMs: 0,
  });

  /**
   * Po awarii silnika zwalniamy model — kolejna próba wystartuje na czystym
   * urządzeniu GPU zamiast trafić na to samo, już uszkodzone.
   */
  if (fatalError !== null) {
    await llmEngine.unload().catch(() => undefined);
  }

  return {
    cardsAdded,
    fatalError,
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
