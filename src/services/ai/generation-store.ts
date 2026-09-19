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
  /** Ile fiszek zwrócił model, zanim walidacja je odsiała. */
  returned: number;
  /** Czytelne wyjaśnienie, dlaczego powstało mniej fiszek (albo zero). */
  outcomeNote: string | null;
  /** Ile fragmentów wymagało powtórki. */
  retriedChunks: number;
  /** Skrócona surowa odpowiedź modelu — do zgłoszenia problemu. */
  debugSample: string | null;
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
  returned: 0,
  outcomeNote: null,
  retriedChunks: 0,
  debugSample: null,
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

      if (result.fatalError !== null) {
        // Awaria silnika: fiszki sprzed awarii są już w bazie, mówimy to wprost
        // i podpowiadamy, co zmienić, zamiast zostawiać suchy komunikat błędu.
        this.setState({
          status: 'error',
          phase: 'cancelled',
          cardsAdded: result.cardsAdded,
          rejected: result.rejected,
          correctedExcerpts: result.correctedExcerpts,
          failedChunks: result.failedChunks,
          etaMs: 0,
          error: describeEngineCrash(result.fatalError, result.cardsAdded),
          message: `Model przerwał pracę po ${result.cardsAdded} fiszkach.`,
        });
        return;
      }

      this.setState({
        status: result.cancelled ? 'cancelled' : 'done',
        phase: result.cancelled ? 'cancelled' : 'done',
        cardsAdded: result.cardsAdded,
        rejected: result.rejected,
        correctedExcerpts: result.correctedExcerpts,
        failedChunks: result.failedChunks,
        returned: result.returned,
        retriedChunks: result.retriedChunks,
        debugSample: result.debugSample,
        outcomeNote: describeOutcome(result),
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
 * Wyjaśnia, dlaczego powstało mniej fiszek, niż można było oczekiwać.
 * Najważniejszy przypadek: zero fiszek mimo „zielonego” przebiegu.
 */
export function describeOutcome(result: {
  cardsAdded: number;
  returned: number;
  failedChunks: number;
  chunkCount: number;
  rejections: { incomplete: number; duplicate: number; ungrounded: number };
  unverifiedExcerpts: number;
  retriedChunks?: number;
}): string | null {
  if (result.cardsAdded === 0) {
    if ((result.retriedChunks ?? 0) > 0 && result.returned === 0) {
      return `Model odpowiadał, ale nie utworzył ani jednej fiszki — nawet po uproszczonej powtórce (${result.retriedChunks} prób). To zwykle za mały model: wybierz w Ustawieniach większy (3B) albo zmniejsz liczbę fiszek z fragmentu. Skopiuj raport i prześlij go, jeśli problem wróci.`;
    }
    if (result.returned === 0 && result.failedChunks >= result.chunkCount) {
      return 'Model nie zwrócił ani jednej fiszki — żaden fragment nie został przetworzony. Spróbuj innego modelu w Ustawieniach.';
    }
    if (result.returned === 0) {
      return 'Model odpowiadał, ale nie utworzył żadnej fiszki. Zwykle pomaga większy model albo mniej fiszek z jednego fragmentu.';
    }
    if (result.rejections.duplicate >= result.returned) {
      return `Wszystkie ${result.returned} fiszek to powtórzenia tych, które już są w talii — materiał jest już przerobiony.`;
    }
    return `Model zwrócił ${result.returned} fiszek, ale żadna nie przeszła walidacji (niekompletne: ${result.rejections.incomplete}, powtórzenia: ${result.rejections.duplicate}, bez pokrycia w materiale: ${result.rejections.ungrounded}).`;
  }

  const notes: string[] = [];
  if (result.rejections.duplicate > 0) notes.push(`${result.rejections.duplicate} powtórzeń pominięto`);
  if (result.rejections.incomplete > 0) notes.push(`${result.rejections.incomplete} niekompletnych odrzucono`);
  if (result.rejections.ungrounded > 0)
    notes.push(`${result.rejections.ungrounded} bez pokrycia w materiale`);
  if (result.unverifiedExcerpts > 0)
    notes.push(`${result.unverifiedExcerpts} cytatów dobrano zastępczo — warto je sprawdzić`);
  if (result.failedChunks > 0) notes.push(`${result.failedChunks} fragmentów nieudanych`);

  return notes.length > 0 ? notes.join(' · ') : null;
}

/**
 * Zamienia techniczną awarię silnika na komunikat, z którym da się coś zrobić.
 * Zapisane fiszki zostają — to najważniejsza informacja dla użytkownika.
 */
export function describeEngineCrash(reason: string, cardsAdded: number): string {
  const saved =
    cardsAdded > 0
      ? `Fiszki utworzone do tej pory (${cardsAdded}) są zapisane.`
      : 'Nie zdążyła powstać żadna fiszka.';

  if (/device lost|webgpu|adapter|destroyed/i.test(reason)) {
    return `Sterownik GPU przerwał pracę modelu. ${saved} Wybierz mniejszy model w Ustawieniach, zamknij inne karty i spróbuj ponownie.`;
  }
  if (/out of memory|\boom\b|allocation/i.test(reason)) {
    return `Zabrakło pamięci GPU. ${saved} Pomaga mniejszy model (0.5B–1B) oraz mniejsza liczba fiszek z jednego fragmentu.`;
  }
  if (/context window|exceed/i.test(reason)) {
    return `Materiał przekroczył okno kontekstu modelu. ${saved} Zmniejsz liczbę fiszek z jednego fragmentu i spróbuj ponownie.`;
  }
  return `Model przerwał pracę: ${reason}. ${saved} Spróbuj ponownie z mniejszym modelem.`;
}

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
