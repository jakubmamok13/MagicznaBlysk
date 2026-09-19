import type { CardType, DraftCard, StudyDocument } from '@/lib/db';
import { errorMessage } from '@/lib/utils';

import { llmEngine } from './engine';
import {
  generateFromDocument,
  type GenerationPhase,
  type GenerationProgress,
} from './generate';

/**
 * Stan generowania trzymany poza drzewem Reacta.
 *
 * Dzięki temu proces trwa dalej, gdy użytkownik zamknie okno i przejdzie do
 * innego widoku — a pasek postępu w nagłówku pokazuje, co się dzieje.
 * Jednocześnie działa tylko jedno zadanie: model i tak zajmuje całe GPU.
 */

export type JobStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

export interface GenerationJob {
  status: JobStatus;
  documentId: number;
  deckId: number;
  documentTitle: string;
  phase: GenerationPhase;
  chunkNumber: number;
  chunkCount: number;
  cardsAdded: number;
  message: string;
  /** Ostatnio dodane fiszki — podgląd na żywo. */
  preview: DraftCard[];
  elapsedMs: number;
  etaMs: number | null;
  error: string | null;
  /** Statystyki jakości z zakończonego przebiegu. */
  rejected: number;
  correctedExcerpts: number;
  failedChunks: number;
}

export interface StartGenerationInput {
  document: StudyDocument;
  deckId: number;
  allowedTypes: readonly CardType[];
  cardsPerChunk: number;
  regenerateSummary: boolean;
}

const IDLE_JOB: GenerationJob = {
  status: 'idle',
  documentId: 0,
  deckId: 0,
  documentTitle: '',
  phase: 'analyzing',
  chunkNumber: 0,
  chunkCount: 0,
  cardsAdded: 0,
  message: '',
  preview: [],
  elapsedMs: 0,
  etaMs: null,
  error: null,
  rejected: 0,
  correctedExcerpts: 0,
  failedChunks: 0,
};

/** Ile ostatnio utworzonych fiszek trzymamy w podglądzie. */
const PREVIEW_LIMIT = 6;

class GenerationStore {
  private job: GenerationJob = IDLE_JOB;
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;

  getState = (): GenerationJob => this.job;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(patch: Partial<GenerationJob>): void {
    this.job = { ...this.job, ...patch };
    for (const listener of this.listeners) listener();
  }

  get isRunning(): boolean {
    return this.job.status === 'running';
  }

  /**
   * Uruchamia generowanie. Gdy model nie jest jeszcze w pamięci, najpierw go
   * wczytuje — użytkownik nie musi o tym pamiętać.
   */
  async start(input: StartGenerationInput): Promise<void> {
    if (this.isRunning) {
      throw new Error('Generowanie już trwa — poczekaj na zakończenie albo je przerwij.');
    }

    const controller = new AbortController();
    this.controller = controller;

    this.setState({
      ...IDLE_JOB,
      status: 'running',
      documentId: input.document.id,
      deckId: input.deckId,
      documentTitle: input.document.title,
      phase: 'loading-model',
      message: 'Przygotowanie modelu…',
    });

    try {
      if (llmEngine.getState().status !== 'ready') {
        const unsubscribe = llmEngine.subscribe(() => {
          const engine = llmEngine.getState();
          if (this.job.phase !== 'loading-model') return;
          this.setState({
            message: engine.progressText || 'Wczytywanie modelu…',
            elapsedMs: this.job.elapsedMs,
          });
        });
        try {
          await llmEngine.load();
        } finally {
          unsubscribe();
        }
      }

      if (controller.signal.aborted) {
        this.setState({ status: 'cancelled', phase: 'cancelled', message: 'Przerwano.' });
        return;
      }

      const result = await generateFromDocument({
        document: input.document,
        deckId: input.deckId,
        allowedTypes: input.allowedTypes,
        cardsPerChunk: input.cardsPerChunk,
        regenerateSummary: input.regenerateSummary,
        signal: controller.signal,
        onProgress: (progress: GenerationProgress) => {
          this.setState({
            phase: progress.phase,
            chunkNumber: progress.chunkNumber,
            chunkCount: progress.chunkCount,
            cardsAdded: progress.cardsGenerated,
            message: progress.message,
            elapsedMs: progress.elapsedMs,
            etaMs: progress.etaMs,
            preview:
              progress.newCards.length > 0
                ? [...progress.newCards, ...this.job.preview].slice(0, PREVIEW_LIMIT)
                : this.job.preview,
          });
        },
      });

      this.setState({
        status: result.cancelled ? 'cancelled' : 'done',
        phase: result.cancelled ? 'cancelled' : 'done',
        cardsAdded: result.cardsAdded,
        rejected: result.rejected,
        correctedExcerpts: result.correctedExcerpts,
        failedChunks: result.failedChunks,
        etaMs: 0,
        message: result.cancelled
          ? 'Przerwano — zapisano dotychczasowe fiszki.'
          : `Dodano ${result.cardsAdded} fiszek.`,
      });
    } catch (error) {
      this.setState({
        status: 'error',
        error: errorMessage(error),
        message: 'Generowanie nie powiodło się.',
      });
    } finally {
      this.controller = null;
    }
  }

  /** Przerywa bieżące zadanie; dotychczasowe fiszki są już zapisane. */
  cancel(): void {
    this.controller?.abort();
    llmEngine.interrupt();
  }

  /** Chowa podsumowanie zakończonego zadania. */
  dismiss(): void {
    if (this.isRunning) return;
    this.setState({ ...IDLE_JOB });
  }
}

export const generationStore = new GenerationStore();

/**
 * Postęp całego zadania w procentach. Etapy przygotowania zajmują 0–10%,
 * generowanie fragmentów 10–95%, zapis kompendium resztę.
 */
export function jobPercent(job: GenerationJob): number {
  if (job.status === 'done') return 100;
  if (job.phase === 'loading-model') return 4;
  if (job.phase === 'analyzing') return 8;
  if (job.phase === 'saving') return 97;
  if (job.chunkCount === 0) return 10;
  return Math.min(95, 10 + Math.round((job.chunkNumber / job.chunkCount) * 85));
}

/** Czytelny czas pozostały, np. „ok. 2 min”. */
export function formatEta(etaMs: number | null): string | null {
  if (etaMs === null || etaMs <= 0) return null;
  const seconds = Math.round(etaMs / 1000);
  if (seconds < 45) return `ok. ${Math.max(5, Math.round(seconds / 5) * 5)} s`;
  const minutes = Math.round(seconds / 60);
  return minutes <= 1 ? 'ok. 1 min' : `ok. ${minutes} min`;
}
