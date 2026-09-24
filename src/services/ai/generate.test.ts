import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftCard, StudyDocument } from '@/lib/db';

const addCardsToDeck = vi.fn<(deckId: number, drafts: DraftCard[]) => Promise<number>>();
const updateDocumentSummary = vi.fn<(documentId: number, summary: string) => Promise<void>>();
const generateJson = vi.fn<() => Promise<string>>();
const interrupt = vi.fn<() => void>();
const unload = vi.fn<() => Promise<void>>();
const load = vi.fn<() => Promise<void>>();
const recover = vi.fn<(options?: { hard?: boolean }) => Promise<void>>();
const engineProfile = { isMobile: false };

vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  addCardsToDeck: (deckId: number, drafts: DraftCard[]) => addCardsToDeck(deckId, drafts),
  updateDocumentSummary: (documentId: number, summary: string) =>
    updateDocumentSummary(documentId, summary),
}));

vi.mock('./engine', () => ({
  llmEngine: {
    generateJson: () => generateJson(),
    interrupt: () => interrupt(),
    unload: () => unload(),
    load: () => load(),
    recover: (options?: { hard?: boolean }) => recover(options),
    getState: () => ({ profile: engineProfile }),
  },
}));

const { generateFromDocument } = await import('./generate');

/** Dokument o długości wymuszającej podział na dokładnie dwa fragmenty. */
const PARAGRAPH_A =
  'Mitochondria wytwarzają ATP w procesie fosforylacji oksydacyjnej komórki eukariotycznej. '.repeat(
    16,
  );
const PARAGRAPH_B = 'Rybosomy odpowiadają za syntezę białek na matrycy informacyjnego RNA. '.repeat(16);

const DOCUMENT: StudyDocument = {
  id: 7,
  title: 'Biologia komórki',
  rawContent: `${PARAGRAPH_A}\n\n${PARAGRAPH_B}`,
  structuredSummary: '',
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
};

function response(summary: string, front: string, excerpt: string): string {
  return JSON.stringify({
    summary,
    cards: [
      { type: 'basic', front, back: 'Odpowiedź', sourceExcerpt: excerpt, explanation: 'Bo tak wynika ze źródła.' },
    ],
  });
}

describe('generateFromDocument', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    addCardsToDeck.mockImplementation((_deckId, drafts) => Promise.resolve(drafts.length));
    unload.mockResolvedValue();
    load.mockResolvedValue();
    recover.mockResolvedValue();
    engineProfile.isMobile = false;
    updateDocumentSummary.mockResolvedValue();
  });

  it('przetwarza każdy fragment i zapisuje zebrane fiszki', async () => {
    generateJson
      .mockResolvedValueOnce(
        response('### Mitochondria', 'Co wytwarzają mitochondria?', 'Mitochondria wytwarzają ATP'),
      )
      .mockResolvedValueOnce(
        response('### Rybosomy', 'Za co odpowiadają rybosomy?', 'Rybosomy odpowiadają za syntezę białek'),
      );

    const result = await generateFromDocument({
      document: DOCUMENT,
      deckId: 3,
      allowedTypes: ['basic'],
      cardsPerChunk: 1,
      regenerateSummary: true,
    });

    expect(result.chunkCount).toBe(2);
    expect(generateJson).toHaveBeenCalledTimes(2);
    expect(result.cardsAdded).toBe(2);
    expect(result.failedChunks).toBe(0);
    expect(result.cancelled).toBe(false);

    // Zapis jest inkrementalny: jedno wywołanie na fragment, nie jedno zbiorcze.
    expect(addCardsToDeck).toHaveBeenCalledTimes(2);
    const [deckId, drafts] = addCardsToDeck.mock.calls[0] ?? [];
    expect(deckId).toBe(3);
    expect(drafts).toHaveLength(1);

    expect(updateDocumentSummary).toHaveBeenCalledWith(
      7,
      expect.stringContaining('# Kompendium: Biologia komórki'),
    );
    expect(result.summary).toContain('### Mitochondria');
    expect(result.summary).toContain('### Rybosomy');
  });

  it('zapisuje fiszki po każdym fragmencie, nie dopiero na końcu', async () => {
    const savedAt: number[] = [];
    addCardsToDeck.mockImplementation((_deckId, drafts) => {
      savedAt.push(generateJson.mock.calls.length);
      return Promise.resolve(drafts.length);
    });
    generateJson.mockResolvedValue(
      response('### A', 'Co wytwarzają mitochondria?', 'Mitochondria wytwarzają ATP'),
    );

    await generateFromDocument({
      document: DOCUMENT,
      deckId: 3,
      allowedTypes: ['basic'],
      cardsPerChunk: 1,
      regenerateSummary: false,
    });

    // Pierwszy zapis następuje po pierwszym zapytaniu do modelu, nie po ostatnim.
    expect(savedAt[0]).toBe(1);
  });

  it('ponawia fragment, gdy model zwróci pustą listę fiszek', async () => {
    // Gramatyka dopuszcza {"summary":"…","cards":[]} — mniejsze modele tak robią.
    generateJson
      .mockResolvedValueOnce(JSON.stringify({ summary: '### A', cards: [] }))
      .mockResolvedValueOnce(
        JSON.stringify({
          cards: [
            {
              type: 'basic',
              front: 'Co wytwarzają mitochondria?',
              back: 'ATP',
              sourceExcerpt: 'Mitochondria wytwarzają ATP',
              explanation: 'Wynika to wprost z tekstu.',
            },
          ],
        }),
      )
      .mockResolvedValue(JSON.stringify({ summary: '', cards: [] }));

    const result = await generateFromDocument({
      document: DOCUMENT,
      deckId: 3,
      allowedTypes: ['basic'],
      cardsPerChunk: 1,
      regenerateSummary: true,
    });

    expect(result.retriedChunks).toBeGreaterThan(0);
    expect(result.cardsAdded).toBe(1);
  });

  it('zapisuje próbkę odpowiedzi, gdy model nie tworzy fiszek', async () => {
    generateJson.mockResolvedValue(JSON.stringify({ summary: 'nic', cards: [] }));

    const result = await generateFromDocument({
      document: DOCUMENT,
      deckId: 3,
      allowedTypes: ['basic'],
      cardsPerChunk: 1,
      regenerateSummary: true,
    });

    expect(result.cardsAdded).toBe(0);
    expect(result.debugSample).toContain('cards');
    expect(result.retriedChunks).toBe(2);
  });

  it('deduplikuje identyczne fiszki z różnych fragmentów', async () => {
    const duplicate = response('### A', 'Co wytwarzają mitochondria?', 'Mitochondria wytwarzają ATP');
    generateJson.mockResolvedValue(duplicate);

    const result = await generateFromDocument({
      document: DOCUMENT,
      deckId: 3,
      allowedTypes: ['basic'],
      cardsPerChunk: 1,
      regenerateSummary: false,
    });

    expect(result.cardsAdded).toBe(1);
    expect(result.rejected).toBe(1);
  });

  it('przerywa pracę po sygnale abort i zapisuje to, co zdążył zebrać', async () => {
    const controller = new AbortController();
    generateJson.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(
        response('### Mitochondria', 'Co wytwarzają mitochondria?', 'Mitochondria wytwarzają ATP'),
      );
    });

    const result = await generateFromDocument({
      document: DOCUMENT,
      deckId: 3,
      allowedTypes: ['basic'],
      cardsPerChunk: 1,
      regenerateSummary: true,
      signal: controller.signal,
    });

    expect(interrupt).toHaveBeenCalled();
    expect(generateJson).toHaveBeenCalledTimes(1);
    expect(result.cancelled).toBe(true);
    expect(result.cardsAdded).toBe(1);
  });

  it('po ubiciu workera wczytuje model ponownie i kontynuuje', async () => {
    // Tak wygląda ubicie workera przez system na telefonie.
    const notLoaded = new Error(
      'ModelNotLoadedError: Model not loaded before trying to complete ChatCompletionRequest.',
    );
    generateJson
      .mockRejectedValueOnce(notLoaded)
      .mockResolvedValue(
        response('### A', 'Co wytwarzają mitochondria?', 'Mitochondria wytwarzają ATP'),
      );

    const result = await generateFromDocument({
      document: DOCUMENT,
      deckId: 3,
      allowedTypes: ['basic'],
      cardsPerChunk: 1,
      regenerateSummary: true,
    });

    // recover(), nie load() — load() uznałby, że model wciąż jest gotowy.
    expect(recover).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
    expect(result.modelReloads).toBe(1);
    expect(result.cardsAdded).toBeGreaterThan(0);
    // To nie jest awaria krytyczna — przebieg trwa dalej.
    expect(result.fatalError).toBeNull();
  });

  it('„Object has already been disposed” odzyskuje twardym restartem workera', async () => {
    // Dokładny komunikat z raportu użytkownika (iPhone, build 2feb0fe).
    generateJson
      .mockRejectedValueOnce(new Error('Error: The current Object has already been disposed.'))
      .mockResolvedValue(
        response('### A', 'Co wytwarzają mitochondria?', 'Mitochondria wytwarzają ATP'),
      );

    const result = await generateFromDocument({
      document: DOCUMENT,
      deckId: 3,
      allowedTypes: ['basic'],
      cardsPerChunk: 1,
      regenerateSummary: true,
    });

    expect(recover).toHaveBeenCalledWith({ hard: true });
    expect(result.modelReloads).toBe(1);
    expect(result.cardsAdded).toBeGreaterThan(0);
    expect(result.fatalError).toBeNull();
  });

  it('raport końcowy podaje faktycznie przetworzone fragmenty, nie wszystkie', async () => {
    // Materiał na wiele fragmentów; trzy błędy pod rząd zatrzymują przebieg.
    const long = { ...DOCUMENT, rawContent: Array.from({ length: 8 }, () => PARAGRAPH_A).join('\n\n') };
    generateJson.mockRejectedValue(new Error('Niepoprawny JSON'));
    const phases: { chunkNumber: number; chunkCount: number }[] = [];

    const result = await generateFromDocument({
      document: long,
      deckId: 3,
      allowedTypes: ['basic'],
      cardsPerChunk: 1,
      regenerateSummary: false,
      onProgress: (p) => { if (p.phase === 'done' || p.phase === 'saving') phases.push(p); },
    });

    expect(result.chunkCount).toBeGreaterThan(3);
    expect(phases.at(-1)?.chunkNumber).toBe(3);
  });

  it('przy uporczywym ubijaniu workera nie zapętla się', async () => {
    generateJson.mockRejectedValue(
      new Error('ModelNotLoadedError: Model not loaded before trying to complete request.'),
    );

    const result = await generateFromDocument({
      document: DOCUMENT,
      deckId: 3,
      allowedTypes: ['basic'],
      cardsPerChunk: 1,
      regenerateSummary: true,
    });

    // Jedna próba wczytania modelu na fragment, nigdy więcej niż limit.
    expect(result.modelReloads).toBeGreaterThan(0);
    expect(result.modelReloads).toBeLessThanOrEqual(3);
    expect(recover).toHaveBeenCalledTimes(result.modelReloads);
    expect(result.cardsAdded).toBe(0);
    expect(result.failedChunks).toBeGreaterThan(0);
  });

  it('na telefonie tnie materiał na drobniejsze fragmenty', async () => {
    generateJson.mockResolvedValue(JSON.stringify({ summary: '', cards: [] }));

    engineProfile.isMobile = false;
    const desktop = await generateFromDocument({
      document: DOCUMENT, deckId: 3, allowedTypes: ['basic'], cardsPerChunk: 1, regenerateSummary: false,
    });

    engineProfile.isMobile = true;
    const mobile = await generateFromDocument({
      document: DOCUMENT, deckId: 3, allowedTypes: ['basic'], cardsPerChunk: 1, regenerateSummary: false,
    });

    expect(mobile.chunkCount).toBeGreaterThan(desktop.chunkCount);
  });

  it('awaria silnika przerywa przebieg i zwalnia model', async () => {
    generateJson.mockRejectedValue(new Error('WebGPU device lost'));

    const result = await generateFromDocument({
      document: DOCUMENT,
      deckId: 3,
      allowedTypes: ['basic'],
      cardsPerChunk: 1,
      regenerateSummary: true,
    });

    // Drugi fragment nie jest nawet próbowany — silnik i tak by poległ.
    expect(generateJson).toHaveBeenCalledTimes(1);
    expect(result.fatalError).toContain('device lost');
    expect(unload).toHaveBeenCalled();
  });

  it('zwykły błąd fragmentu nie przerywa całości', async () => {
    generateJson
      .mockRejectedValueOnce(new Error('Niepoprawny JSON'))
      .mockResolvedValueOnce(
        response('### B', 'Za co odpowiadają rybosomy?', 'Rybosomy odpowiadają za syntezę białek'),
      );

    const result = await generateFromDocument({
      document: DOCUMENT,
      deckId: 3,
      allowedTypes: ['basic'],
      cardsPerChunk: 1,
      regenerateSummary: true,
    });

    expect(result.fatalError).toBeNull();
    expect(result.failedChunks).toBe(1);
    expect(result.cardsAdded).toBe(1);
    expect(unload).not.toHaveBeenCalled();
  });

  it('nie nadpisuje istniejącego kompendium bez zgody użytkownika', async () => {
    generateJson.mockResolvedValue(
      response('### Nowe', 'Co wytwarzają mitochondria?', 'Mitochondria wytwarzają ATP'),
    );

    await generateFromDocument({
      document: { ...DOCUMENT, structuredSummary: '# Stare kompendium' },
      deckId: 3,
      allowedTypes: ['basic'],
      cardsPerChunk: 1,
      regenerateSummary: false,
    });

    expect(updateDocumentSummary).not.toHaveBeenCalled();
  });

  it('odrzuca pusty materiał i brak wybranych typów', async () => {
    await expect(
      generateFromDocument({
        document: { ...DOCUMENT, rawContent: '   ' },
        deckId: 3,
        allowedTypes: ['basic'],
        cardsPerChunk: 2,
        regenerateSummary: true,
      }),
    ).rejects.toThrow(/pusty/i);

    await expect(
      generateFromDocument({
        document: DOCUMENT,
        deckId: 3,
        allowedTypes: [],
        cardsPerChunk: 2,
        regenerateSummary: true,
      }),
    ).rejects.toThrow(/typ/i);
  });
});
