import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyDocument } from '@/lib/db';
import type { GenerationProgress } from './generate';

const engineState = { status: 'ready' as string };
const load = vi.fn<() => Promise<void>>();
const interrupt = vi.fn<() => void>();
const unload = vi.fn<() => Promise<void>>();
const generateFromDocument =
  vi.fn<(options: { onProgress?: (p: GenerationProgress) => void; signal?: AbortSignal }) => Promise<unknown>>();

vi.mock('./engine', () => ({
  llmEngine: {
    getState: () => engineState,
    subscribe: () => () => undefined,
    load: () => load(),
    interrupt: () => interrupt(),
    unload: () => unload(),
  },
}));

vi.mock('./generate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./generate')>()),
  generateFromDocument: (options: Parameters<typeof generateFromDocument>[0]) =>
    generateFromDocument(options),
}));

const { generationStore, formatEta, jobPercent, describeEngineCrash, describeOutcome } =
  await import('./generation-store');

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
  fatalError: null,
  returned: 14,
  rejections: { incomplete: 0, duplicate: 2, ungrounded: 0 },
  unverifiedExcerpts: 0,
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
    unload.mockResolvedValue();
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
    generateFromDocument.mockImplementation((options) => {
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
      return Promise.resolve(RESULT);
    });

    await generationStore.start(START);
    expect(generationStore.getState().preview.length).toBeGreaterThan(0);
  });

  it('ogranicza podgląd do kilku ostatnich fiszek', async () => {
    generateFromDocument.mockImplementation((options) => {
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
      return Promise.resolve(RESULT);
    });

    await generationStore.start(START);
    expect(generationStore.getState().preview.length).toBeLessThanOrEqual(6);
  });

  it('przerwanie oznacza zadanie jako anulowane i zatrzymuje model', async () => {
    generateFromDocument.mockImplementation((options) => {
      generationStore.cancel();
      expect(options.signal?.aborted).toBe(true);
      return Promise.resolve({ ...RESULT, cancelled: true, cardsAdded: 3 });
    });

    await generationStore.start(START);
    expect(interrupt).toHaveBeenCalled();
    expect(generationStore.getState().status).toBe('cancelled');
    expect(generationStore.getState().cardsAdded).toBe(3);
  });

  it('awaria silnika daje komunikat z podpowiedzią i liczbą zapisanych fiszek', async () => {
    generateFromDocument.mockResolvedValue({
      ...RESULT,
      cardsAdded: 7,
      fatalError: 'WebGPU device lost',
    });

    await generationStore.start(START);
    const job = generationStore.getState();
    expect(job.status).toBe('error');
    expect(job.cardsAdded).toBe(7);
    expect(job.error).toContain('7');
    expect(job.error).toMatch(/mniejszy model/i);
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

describe('describeOutcome', () => {
  const base = {
    cardsAdded: 0,
    returned: 0,
    failedChunks: 0,
    chunkCount: 15,
    rejections: { incomplete: 0, duplicate: 0, ungrounded: 0 },
    unverifiedExcerpts: 0,
  };

  it('po nieudanych powtórkach podpowiada większy model', () => {
    const note = describeOutcome({ ...base, retriedChunks: 15 });
    expect(note).toMatch(/powtórce/);
    expect(note).toMatch(/3B|większy/);
  });

  it('tłumaczy wynik „zero fiszek”, gdy model nic nie zwrócił', () => {
    expect(describeOutcome({ ...base, failedChunks: 15 })).toMatch(/ani jednej fiszki/);
    expect(describeOutcome(base)).toMatch(/nie utworzył żadnej fiszki/);
  });

  it('tłumaczy zero fiszek, gdy walidacja odrzuciła wszystko', () => {
    const note = describeOutcome({
      ...base,
      returned: 20,
      rejections: { incomplete: 5, duplicate: 3, ungrounded: 12 },
    });
    expect(note).toContain('20');
    expect(note).toContain('12');
  });

  it('rozpoznaje materiał już przerobiony', () => {
    expect(
      describeOutcome({ ...base, returned: 8, rejections: { incomplete: 0, duplicate: 8, ungrounded: 0 } }),
    ).toMatch(/powtórzenia/);
  });

  it('przy udanym przebiegu podsumowuje jakość, a bez uwag milczy', () => {
    expect(describeOutcome({ ...base, cardsAdded: 10, returned: 10 })).toBeNull();
    expect(
      describeOutcome({ ...base, cardsAdded: 10, returned: 12, unverifiedExcerpts: 3 }),
    ).toMatch(/cytatów dobrano zastępczo/);
  });
});

describe('describeEngineCrash', () => {
  it('rozpoznaje utratę GPU, brak pamięci i przepełnienie kontekstu', () => {
    expect(describeEngineCrash('WebGPU device lost', 5)).toMatch(/Sterownik GPU/);
    expect(describeEngineCrash('out of memory', 5)).toMatch(/pamięci GPU/);
    expect(describeEngineCrash('context window exceeded', 5)).toMatch(/okno kontekstu/);
  });

  it('zawsze informuje, czy fiszki ocalały', () => {
    expect(describeEngineCrash('device lost', 12)).toContain('12');
    expect(describeEngineCrash('device lost', 0)).toMatch(/żadna fiszka/);
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
