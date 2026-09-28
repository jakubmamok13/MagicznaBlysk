import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftCard, StudyDocument } from '@/lib/db';
import { EngineRuntimeError } from './errors';

const addCardsToDeck = vi.fn<(deckId: number, drafts: DraftCard[]) => Promise<number>>();
const updateDocumentSummary = vi.fn<(documentId: number, summary: string) => Promise<void>>();
const generateJson = vi.fn<(request: { grammar: string; maxTokens: number }) => Promise<{ content: string; finishReason: string | null }>>();
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
    generateJson: (request: { grammar: string; maxTokens: number }) => generateJson(request),
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

function payload(summary: string, front: string, excerpt: string): string {
  // Kanoniczny JSON — dokładnie taki kształt wymusza gramatyka (fiszki przed kompendium).
  return JSON.stringify({
    cards: [
      { type: 'basic', front, back: 'Odpowiedź', sourceExcerpt: excerpt, explanation: 'Bo tak wynika ze źródła.' },
    ],
    summary,
  });
}

function reply(content: string, finishReason: string | null = 'stop'): { content: string; finishReason: string | null } {
  return { content, finishReason };
}

const GOOD = reply(payload('### A', 'Co wytwarzają mitochondria?', 'Mitochondria wytwarzają ATP'));
const LONG_DOCUMENT = { ...DOCUMENT, rawContent: Array.from({ length: 8 }, () => PARAGRAPH_A).join('\n\n') };

function run(
  document: StudyDocument = DOCUMENT,
  extra: Partial<Parameters<typeof generateFromDocument>[0]> = {},
): ReturnType<typeof generateFromDocument> {
  return generateFromDocument({
    document,
    deckId: 3,
    allowedTypes: ['basic'],
    cardsPerChunk: 1,
    regenerateSummary: true,
    ...extra,
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

  it('przetwarza każdy fragment i zapisuje fiszki po każdym z nich', async () => {
    generateJson
      .mockResolvedValueOnce(reply(payload('### Mitochondria', 'Co wytwarzają mitochondria?', 'Mitochondria wytwarzają ATP')))
      .mockResolvedValueOnce(reply(payload('### Rybosomy', 'Za co odpowiadają rybosomy?', 'Rybosomy odpowiadają za syntezę białek')));

    const result = await run();

    expect(result.chunkCount).toBe(2);
    expect(result.cardsAdded).toBe(2);
    expect(result.failedChunks).toBe(0);
    expect(addCardsToDeck).toHaveBeenCalledTimes(2);
    expect(updateDocumentSummary).toHaveBeenCalledWith(7, expect.stringContaining('# Kompendium: Biologia komórki'));
    expect(result.summary).toContain('### Mitochondria');
    expect(result.summary).toContain('### Rybosomy');
  });

  it('wysyła gramatykę (nie schemat JSON) i budżet tokenów liczony z niej', async () => {
    const { tokenBudget } = await import('./grammar');
    generateJson.mockResolvedValue(GOOD);

    await run(DOCUMENT, { cardsPerChunk: 3 });

    const request = generateJson.mock.calls[0]?.[0];
    expect(request?.grammar).toMatch(/^root ::= "\{\\"cards\\":\[" card/);
    expect(request?.maxTokens).toBe(tokenBudget(3));
  });

  it('odpowiedź uciętą limitem tokenów ratuje: zachowuje domknięte fiszki', async () => {
    const full = JSON.stringify({
      cards: [
        { type: 'basic', front: 'Co wytwarzają mitochondria?', back: 'ATP', sourceExcerpt: 'Mitochondria wytwarzają ATP', explanation: 'Z tekstu.' },
        { type: 'basic', front: 'Gdzie zachodzi fosforylacja?', back: 'W mitochondriach', sourceExcerpt: 'fosforylacji oksydacyjnej', explanation: 'Z tekstu.' },
      ],
      summary: 'Długie kompendium, które się nie zmieściło',
    });
    const cut = full.slice(0, full.indexOf('Długie') + 6);
    generateJson.mockResolvedValue(reply(cut, 'length'));

    const result = await run(DOCUMENT, { cardsPerChunk: 2 });

    expect(result.truncatedResponses).toBeGreaterThan(0);
    expect(result.cardsAdded).toBe(2);
    expect(result.failedChunks).toBe(0);
  });

  it('ucięcie przed pierwszą fiszką to nieudany fragment z próbką w raporcie, ale praca trwa', async () => {
    generateJson
      .mockResolvedValueOnce(reply('{"cards":[{"type":"basic","front":"Co wytwa', 'length'))
      .mockResolvedValueOnce(reply(payload('### B', 'Za co odpowiadają rybosomy?', 'Rybosomy odpowiadają za syntezę białek')));

    const result = await run();

    expect(result.failedChunks).toBe(1);
    expect(result.cardsAdded).toBe(1);
    expect(result.fatalError).toBeNull();
    expect(result.debugSample).toContain('ucięta');
    expect(result.debugSample).toContain('Co wytwa');
  });

  it('nieczytelna odpowiedź jednego fragmentu nie zatrzymuje pozostałych (brak limitu „3 pod rząd”)', async () => {
    generateJson.mockResolvedValueOnce(reply('śmieci')).mockResolvedValue(GOOD);

    const result = await run(LONG_DOCUMENT);

    expect(result.failedChunks).toBe(1);
    expect(result.cardsAdded).toBe(1); // reszta to duplikaty tej samej fiszki
    expect(generateJson).toHaveBeenCalledTimes(result.chunkCount);
  });

  it('deduplikuje identyczne fiszki z różnych fragmentów', async () => {
    generateJson.mockResolvedValue(GOOD);
    const result = await run(DOCUMENT, { regenerateSummary: false });
    expect(result.cardsAdded).toBe(1);
    expect(result.rejected).toBe(1);
  });

  it('przerywa pracę po sygnale abort i zapisuje to, co zdążył zebrać', async () => {
    const controller = new AbortController();
    generateJson.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(GOOD);
    });

    const result = await run(DOCUMENT, { signal: controller.signal });

    expect(interrupt).toHaveBeenCalled();
    expect(generateJson).toHaveBeenCalledTimes(1);
    expect(result.cancelled).toBe(true);
    expect(result.cardsAdded).toBe(1);
  });

  it('„map async was not successful” (raport z iPhone’a): odtwarza silnik i powtarza fragment', async () => {
    generateJson
      .mockRejectedValueOnce(new EngineRuntimeError('OperationError: map async was not successful'))
      .mockResolvedValue(GOOD);

    const result = await run();

    expect(recover).toHaveBeenCalledWith({ hard: true });
    expect(load).not.toHaveBeenCalled();
    expect(result.modelReloads).toBe(1);
    expect(result.cardsAdded).toBeGreaterThan(0);
    expect(result.fatalError).toBeNull();
  });

  it('ModelNotLoadedError i „disposed” też uruchamiają odtworzenie', async () => {
    generateJson
      .mockRejectedValueOnce(new Error('ModelNotLoadedError: Model not loaded before trying to complete request.'))
      .mockRejectedValueOnce(new Error('Error: The current Object has already been disposed.'))
      .mockResolvedValue(GOOD);

    const result = await run();

    expect(recover).toHaveBeenCalledTimes(2);
    expect(result.cardsAdded).toBeGreaterThan(0);
  });

  it('uporczywa awaria GPU: 2 odtworzenia, potem jasny komunikat i koniec — bez mielenia fragmentów', async () => {
    generateJson.mockRejectedValue(new EngineRuntimeError('OperationError: map async was not successful'));

    const result = await run(LONG_DOCUMENT);

    expect(recover).toHaveBeenCalledTimes(2);
    expect(generateJson).toHaveBeenCalledTimes(3);
    expect(result.modelReloads).toBe(2);
    expect(result.fatalError).toMatch(/odmawia pracy/);
    expect(result.fatalError).toMatch(/map async/);
    expect(result.failedChunks).toBe(1);
    expect(unload).toHaveBeenCalled();
  });

  it('gdy odtworzenie pomaga przy każdym fragmencie — przebieg idzie do końca', async () => {
    let call = 0;
    generateJson.mockImplementation(() => {
      call += 1;
      return call % 2 === 1
        ? Promise.reject(new EngineRuntimeError('OperationError: map async was not successful'))
        : Promise.resolve(reply(payload('### A', `Pytanie ${call}?`, 'Mitochondria wytwarzają ATP')));
    });

    const result = await run(LONG_DOCUMENT);

    expect(result.chunkCount).toBeGreaterThan(3);
    expect(result.modelReloads).toBe(result.chunkCount);
    expect(result.fatalError).toBeNull();
    expect(result.cardsAdded).toBe(result.chunkCount);
  });

  it('błędy deterministyczne (gramatyka, okno kontekstu) nie uruchamiają bezcelowego odtwarzania', async () => {
    generateJson.mockRejectedValue(new EngineRuntimeError('Prompt tokens exceed context window size'));
    const context = await run();
    expect(recover).not.toHaveBeenCalled();
    expect(context.fatalError).toMatch(/context window/);

    vi.clearAllMocks();
    generateJson.mockRejectedValue(new EngineRuntimeError('GrammarMatcherInitError: invalid grammar'));
    const grammar = await run();
    expect(recover).not.toHaveBeenCalled();
    expect(grammar.fatalError).toMatch(/Grammar/);
  });

  it('nieudane odtworzenie (np. brak pamięci przy wczytywaniu) kończy przebieg z jego komunikatem', async () => {
    generateJson.mockRejectedValue(new EngineRuntimeError('map async was not successful'));
    recover.mockRejectedValue(new Error('Device lost during reload'));

    const result = await run(LONG_DOCUMENT);

    expect(recover).toHaveBeenCalledTimes(1);
    expect(result.fatalError).toMatch(/Nie udało się ponownie wczytać modelu: Device lost during reload/);
    expect(generateJson).toHaveBeenCalledTimes(1);
  });

  it('na telefonie tnie materiał na drobniejsze fragmenty', async () => {
    generateJson.mockResolvedValue(GOOD);
    engineProfile.isMobile = false;
    const desktop = await run(DOCUMENT, { regenerateSummary: false });
    engineProfile.isMobile = true;
    const mobile = await run(DOCUMENT, { regenerateSummary: false });
    expect(mobile.chunkCount).toBeGreaterThan(desktop.chunkCount);
  });
});
