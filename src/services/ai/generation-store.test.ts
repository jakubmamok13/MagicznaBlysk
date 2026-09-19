import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyDocument } from '@/lib/db';
import type { GenerationProgress } from './generate';

const engineState = { status: 'ready' as string };
const load = vi.fn<() => Promise<void>>();
const interrupt = vi.fn<() => void>();
const generateFromDocument =
  vi.fn<(options: { onProgress?: (p: GenerationProgress) => void; signal?: AbortSignal }) => Promise<unknown>>();

vi.mock('./engine', () => ({
  llmEngine: {
    getState: () => engineState,
    subscribe: () => () => undefined,
    load: () => load(),
    interrupt: () => interrupt(),
  },
}));

vi.mock('./generate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./generate')>()),
  generateFromDocument: (options: Parameters<typeof generateFromDocument>[0]) =>
    generateFromDocument(options),
}));

const { generationStore, formatEta, jobPercent } = await import('./generation-store');

const DOCUMENT: StudyDocument = {
  id: 5,
  title: 'Prawo cywilne',
  rawContent: 'treść',
  structuredSummary: '',
  createdAt: new Date(),
};

function progress(patch: Partial<GenerationProgress>): GenerationProgress {
  return {
    phase: 'generating',
    chunkNumber: 1,
    chunkCount: 4,
    cardsGenerated: 0,
    message: '',
    newCards: [],
    elapsedMs: 1000,
    etaMs: null,
    ...patch,
  };
}

const RESULT = {
  cardsAdded: 12,
  rejected: 2,
  correctedExcerpts: 1,
  failedChunks: 0,
  chunkCount: 4,
  cancelled: false,
  summary: '# Kompendium',
};

const START = {
  document: DOCUMENT,
  deckId: 3,
  allowedTypes: ['basic'] as const,
  cardsPerChunk: 4,
  regenerateSummary: true,
};

describe('generationStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generationStore.dismiss();
    engineState.status = 'ready';
    load.mockResolvedValue();
  });

  it('startuje od wczytania modelu i kończy sukcesem', async () => {
    generateFromDocument.mockResolvedValue(RESULT);
    await generationStore.start(START);

    const job = generationStore.getState();
    expect(job.status).toBe('done');
    expect(job.cardsAdded).toBe(12);
    expect(job.rejected).toBe(2);
    expect(job.documentTitle).toBe('Prawo cywilne');
    expect(job.message).toContain('12');
  });

  it('wczytuje model, gdy nie jest gotowy', async () => {
    engineState.status = 'unloaded';
    generateFromDocument.mockResolvedValue(RESULT);
    await generationStore.start(START);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('nie wczytuje modelu, gdy już działa', async () => {
    generateFromDocument.mockResolvedValue(RESULT);
    await generationStore.start(START);
    expect(load).not.toHaveBeenCalled();
  });

  it('gromadzi podgląd ostatnich fiszek i aktualizuje etapy', async () => {
    generateFromDocument.mockImplementation(async (options) => {
      options.onProgress?.(
        progress({
          chunkNumber: 1,
          cardsGenerated: 2,
          newCards: [
            { type: 'basic', front: 'Pytanie 1', back: 'x', sourceExcerpt: 'y', explanation: '' },
            { type: 'cloze', front: '{{c1::luka}}', back: 'x', sourceExcerpt: 'y', explanation: '' },
          ],
        }),
      );
      const mid = generationStore.getState();
      expect(mid.status).toBe('running');
      expect(mid.phase).toBe('generating');
      expect(mid.preview).toHaveLength(2);
      expect(mid.cardsAdded).toBe(2);
      return RESULT;
    });

    await generationStore.start(START);
    expect(generationStore.getState().preview.length).toBeGreaterThan(0);
  });

  it('ogranicza podgląd do kilku ostatnich fiszek', async () => {
    generateFromDocument.mockImplementation(async (options) => {
      for (let i = 0; i < 5; i += 1) {
        options.onProgress?.(
          progress({
            newCards: [
              { type: 'basic', front: `P${i}a`, back: 'x', sourceExcerpt: 'y', explanation: '' },
              { type: 'basic', front: `P${i}b`, back: 'x', sourceExcerpt: 'y', explanation: '' },
            ],
          }),
        );
      }
      return RESULT;
    });

    await generationStore.start(START);
    expect(generationStore.getState().preview.length).toBeLessThanOrEqual(6);
  });

  it('przerwanie oznacza zadanie jako anulowane i zatrzymuje model', async () => {
    generateFromDocument.mockImplementation(async (options) => {
      generationStore.cancel();
      expect(options.signal?.aborted).toBe(true);
      return { ...RESULT, cancelled: true, cardsAdded: 3 };
    });

    await generationStore.start(START);
    expect(interrupt).toHaveBeenCalled();
    expect(generationStore.getState().status).toBe('cancelled');
    expect(generationStore.getState().cardsAdded).toBe(3);
  });

  it('błąd zapisuje komunikat zamiast wywracać aplikację', async () => {
    generateFromDocument.mockRejectedValue(new Error('brak pamięci GPU'));
    await generationStore.start(START);
    const job = generationStore.getState();
    expect(job.status).toBe('error');
    expect(job.error).toContain('brak pamięci GPU');
  });

  it('nie pozwala uruchomić dwóch zadań naraz', async () => {
    let release = (): void => undefined;
    generateFromDocument.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve(RESULT); }),
    );

    const first = generationStore.start(START);
    await expect(generationStore.start(START)).rejects.toThrow(/już trwa/);
    release();
    await first;
  });

  it('powiadamia subskrybentów o zmianach', async () => {
    const listener = vi.fn();
    const unsubscribe = generationStore.subscribe(listener);
    generateFromDocument.mockResolvedValue(RESULT);
    await generationStore.start(START);
    unsubscribe();
    expect(listener.mock.calls.length).toBeGreaterThan(1);
  });

  it('dismiss czyści zakończone zadanie, ale nie trwające', async () => {
    generateFromDocument.mockResolvedValue(RESULT);
    await generationStore.start(START);
    generationStore.dismiss();
    expect(generationStore.getState().status).toBe('idle');
  });
});

describe('jobPercent i formatEta', () => {
  const base = { ...generationStore.getState() };

  it('rośnie wraz z przetworzonymi fragmentami', () => {
    const early = jobPercent({ ...base, status: 'running', phase: 'generating', chunkNumber: 1, chunkCount: 10 });
    const late = jobPercent({ ...base, status: 'running', phase: 'generating', chunkNumber: 9, chunkCount: 10 });
    expect(early).toBeLessThan(late);
    expect(late).toBeLessThanOrEqual(95);
  });

  it('zakończone zadanie to 100%', () => {
    expect(jobPercent({ ...base, status: 'done' })).toBe(100);
  });

  it('formatuje pozostały czas po polsku', () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(0)).toBeNull();
    expect(formatEta(20_000)).toMatch(/^ok\. \d+ s$/);
    expect(formatEta(65_000)).toBe('ok. 1 min');
    expect(formatEta(200_000)).toBe('ok. 3 min');
  });
});
