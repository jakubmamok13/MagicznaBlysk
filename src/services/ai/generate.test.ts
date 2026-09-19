import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftCard, StudyDocument } from '@/lib/db';

const addCardsToDeck = vi.fn<(deckId: number, drafts: DraftCard[]) => Promise<number>>();
const updateDocumentSummary = vi.fn<(documentId: number, summary: string) => Promise<void>>();
const generateJson = vi.fn<() => Promise<string>>();
const interrupt = vi.fn<() => void>();

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
    vi.clearAllMocks();
    addCardsToDeck.mockImplementation((_deckId, drafts) => Promise.resolve(drafts.length));
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

    const [deckId, drafts] = addCardsToDeck.mock.calls[0] ?? [];
    expect(deckId).toBe(3);
    expect(drafts).toHaveLength(2);

    expect(updateDocumentSummary).toHaveBeenCalledWith(
      7,
      expect.stringContaining('# Kompendium: Biologia komórki'),
    );
    expect(result.summary).toContain('### Mitochondria');
    expect(result.summary).toContain('### Rybosomy');
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

  it('kontynuuje mimo błędu jednego fragmentu', async () => {
    generateJson
      .mockRejectedValueOnce(new Error('OOM na GPU'))
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

    expect(result.failedChunks).toBe(1);
    expect(result.cardsAdded).toBe(1);
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
