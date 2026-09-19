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
import { buildGenerationSchema, dedupeKey, parseGenerationResponse } from './schema';

export type GenerationPhase = 'preparing' | 'generating' | 'saving' | 'done' | 'cancelled';

export interface GenerationProgress {
  phase: GenerationPhase;
  /** Numer przetwarzanego fragmentu (1-indeksowany, 0 przed startem). */
  chunkNumber: number;
  chunkCount: number;
  /** Liczba przyjętych fiszek do tej pory. */
  cardsGenerated: number;
  message: string;
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
  /** Fiszki odrzucone przez walidację (duplikaty, braki, brak cytatu). */
  rejected: number;
  /** Cytaty skorygowane do dosłownego fragmentu źródła. */
  correctedExcerpts: number;
  /** Fragmenty, których model nie przetworzył poprawnie. */
  failedChunks: number;
  chunkCount: number;
  cancelled: boolean;
  summary: string;
}

const MAX_TOKENS_PER_CHUNK = 1800;

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

  report({
    phase: 'preparing',
    chunkNumber: 0,
    chunkCount: 0,
    cardsGenerated: 0,
    message: 'Analiza materiału…',
  });

  const chunks = chunkText(document.rawContent);
  if (chunks.length === 0) {
    throw new Error('Materiał jest pusty — dodaj treść, z której mają powstać fiszki.');
  }

  const schema = buildGenerationSchema(allowedTypes);
  const seenFronts = new Set<string>();
  const summaries: string[] = [];
  const collected: DraftCard[] = [];

  let rejected = 0;
  let correctedExcerpts = 0;
  let failedChunks = 0;
  let cancelled = false;

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
      report({
        phase: 'generating',
        chunkNumber,
        chunkCount: chunks.length,
        cardsGenerated: collected.length,
        message: `Fragment ${chunkNumber} z ${chunks.length} — model pracuje lokalnie…`,
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
          maxTokens: MAX_TOKENS_PER_CHUNK,
          temperature: 0.3,
        });

        const parsed = parseGenerationResponse(raw, {
          source: chunk.content,
          allowedTypes,
          seenFronts,
        });

        if (parsed.summary.length > 0) summaries.push(parsed.summary.trim());
        collected.push(...parsed.cards);
        rejected += parsed.rejected;
        correctedExcerpts += parsed.correctedExcerpts;
      } catch (error) {
        if (isAborted()) {
          cancelled = true;
          break;
        }
        failedChunks += 1;
        console.warn(
          `[CognitiveDeck] Fragment ${chunkNumber} nie został przetworzony: ${errorMessage(error)}`,
        );
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  report({
    phase: 'saving',
    chunkNumber: chunks.length,
    chunkCount: chunks.length,
    cardsGenerated: collected.length,
    message: 'Zapisywanie fiszek na urządzeniu…',
  });

  const cardsAdded = await addCardsToDeck(deckId, collected);

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
    message: cancelled ? 'Generowanie przerwane — zapisano dotychczasowe fiszki.' : 'Gotowe.',
  });

  return {
    cardsAdded,
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
