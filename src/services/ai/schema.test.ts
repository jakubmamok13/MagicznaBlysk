import { describe, expect, it } from 'vitest';
import {
  buildGenerationSchema,
  extractJsonObject,
  parseGenerationResponse,
  type ValidationContext,
} from './schema';
import type { CardType } from '@/lib/db';

const SOURCE =
  'Mitochondria wytwarzają ATP w procesie fosforylacji oksydacyjnej. Rybosomy odpowiadają za syntezę białek. Jądro komórkowe przechowuje DNA.';

const ALL_TYPES: readonly CardType[] = ['basic', 'cloze', 'case'];

function context(allowedTypes: readonly CardType[] = ALL_TYPES): ValidationContext {
  return { source: SOURCE, allowedTypes, seenFronts: new Set<string>() };
}

describe('buildGenerationSchema', () => {
  it('zawiera wymagane pola i dozwolone typy', () => {
    const parsed = JSON.parse(buildGenerationSchema(['basic', 'cloze'])) as Record<string, unknown>;
    expect(parsed['required']).toEqual(['summary', 'cards']);
    const properties = parsed['properties'] as Record<string, Record<string, unknown>>;
    const items = properties['cards']?.['items'] as Record<string, unknown>;
    expect(items['required']).toEqual(['type', 'front', 'back', 'sourceExcerpt', 'explanation']);
    const itemProps = items['properties'] as Record<string, Record<string, unknown>>;
    expect(itemProps['type']?.['enum']).toEqual(['basic', 'cloze']);
  });
});

describe('extractJsonObject', () => {
  it('parsuje czysty JSON', () => {
    expect(extractJsonObject('{"summary":"x","cards":[]}')).toEqual({ summary: 'x', cards: [] });
  });

  it('radzi sobie z blokiem markdown i tekstem pobocznym', () => {
    const raw = 'Oto wynik:\n```json\n{"summary":"x","cards":[]}\n```';
    expect(extractJsonObject(raw)).toEqual({ summary: 'x', cards: [] });
  });

  it('rzuca błąd dla nie-JSON', () => {
    expect(() => extractJsonObject('zupełnie nie json')).toThrowError(/JSON/);
  });
});

describe('parseGenerationResponse', () => {
  it('przyjmuje poprawną fiszkę z dosłownym cytatem', () => {
    const raw = JSON.stringify({
      summary: '### Organelle',
      cards: [
        {
          type: 'basic',
          front: 'Co wytwarzają mitochondria?',
          back: 'ATP',
          sourceExcerpt: 'Mitochondria wytwarzają ATP w procesie fosforylacji oksydacyjnej.',
          explanation: 'To główna funkcja mitochondriów.',
        },
      ],
    });
    const result = parseGenerationResponse(raw, context());
    expect(result.cards).toHaveLength(1);
    expect(result.rejected).toBe(0);
    expect(result.correctedExcerpts).toBe(0);
    expect(result.summary).toBe('### Organelle');
  });

  it('parafraza cytatu nie kasuje fiszki — podpina najbliższe zdanie źródła', () => {
    const raw = JSON.stringify({
      summary: '',
      cards: [
        {
          type: 'basic',
          front: 'Gdzie powstaje ATP?',
          back: 'W mitochondriach',
          // Model sparafrazował — dawniej taka fiszka znikała bez śladu.
          sourceExcerpt: 'Energia komórkowa powstaje głównie w mitochondriach',
          explanation: '',
        },
      ],
    });
    const result = parseGenerationResponse(raw, context());
    expect(result.cards).toHaveLength(1);
    expect(result.unverifiedExcerpts).toBe(1);
    expect(result.rejections.ungrounded).toBe(0);
    // Nie zmyślamy źródła: zostaje sformułowanie modelu, jawnie oznaczone.
    expect(result.cards[0]?.verified).toBe(false);
    expect(result.cards[0]?.sourceExcerpt).toContain('Energia komórkowa');
  });

  it('zweryfikowany cytat jest oznaczony jako pewny', () => {
    const raw = JSON.stringify({
      summary: '',
      cards: [
        {
          type: 'basic',
          front: 'Co wytwarzają mitochondria?',
          back: 'ATP',
          sourceExcerpt: 'Mitochondria wytwarzają ATP w procesie fosforylacji oksydacyjnej.',
          explanation: '',
        },
      ],
    });
    const result = parseGenerationResponse(raw, context());
    expect(result.cards[0]?.verified).toBe(true);
    expect(result.unverifiedExcerpts).toBe(0);
  });

  it('rozbija odrzucenia na przyczyny', () => {
    const ctx = context();
    const raw = JSON.stringify({
      summary: '',
      cards: [
        { type: 'basic', front: 'a', back: '', sourceExcerpt: '', explanation: '' },
        {
          type: 'basic',
          front: 'Co wytwarzają mitochondria?',
          back: 'ATP',
          sourceExcerpt: 'Mitochondria wytwarzają ATP',
          explanation: '',
        },
        {
          type: 'basic',
          front: 'Co wytwarzają mitochondria?',
          back: 'ATP',
          sourceExcerpt: 'Mitochondria wytwarzają ATP',
          explanation: '',
        },
      ],
    });
    const result = parseGenerationResponse(raw, ctx);
    expect(result.returned).toBe(3);
    expect(result.cards).toHaveLength(1);
    expect(result.rejections.incomplete).toBe(1);
    expect(result.rejections.duplicate).toBe(1);
    expect(result.rejected).toBe(2);
  });

  it('odrzuca niekompletne, a cytat bez pokrycia tylko oznacza', () => {
    const raw = JSON.stringify({
      summary: '',
      cards: [
        { type: 'basic', front: 'a', back: 'ATP', sourceExcerpt: 'x', explanation: '' },
        {
          type: 'basic',
          front: 'Pytanie nie z tego materiału?',
          back: 'Odpowiedź',
          sourceExcerpt: 'Zupełnie inny temat, np. historia średniowiecznej Europy.',
          explanation: '',
        },
      ],
    });
    const result = parseGenerationResponse(raw, context());

    expect(result.rejections.incomplete).toBe(1);
    // Fiszka zostaje, ale jawnie jako niezweryfikowana — zamiast zniknąć bez śladu.
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]?.verified).toBe(false);
  });

  it('odrzuca fiszkę, gdy nie ma ani cytatu, ani źródła', () => {
    const raw = JSON.stringify({
      summary: '',
      cards: [
        {
          type: 'basic',
          front: 'Pytanie bez żadnego umocowania?',
          back: 'Odpowiedź',
          sourceExcerpt: '',
          explanation: '',
        },
      ],
    });
    const result = parseGenerationResponse(raw, { ...context(), source: '' });
    expect(result.cards).toHaveLength(0);
    expect(result.rejections.ungrounded).toBe(1);
  });

  it('koryguje cytat do najbliższego zdania źródłowego', () => {
    const raw = JSON.stringify({
      summary: '',
      cards: [
        {
          type: 'basic',
          front: 'Za co odpowiadają rybosomy?',
          back: 'Za syntezę białek',
          sourceExcerpt: 'Rybosomy biorą udział w syntezie białek w komórce',
          explanation: '',
        },
      ],
    });
    const result = parseGenerationResponse(raw, context());
    expect(result.correctedExcerpts).toBe(1);
    expect(result.cards[0]?.sourceExcerpt).toBe('Rybosomy odpowiadają za syntezę białek.');
  });

  it('deduplikuje fiszki po awersie (również między fragmentami)', () => {
    const card = {
      type: 'basic',
      front: 'Co przechowuje jądro komórkowe?',
      back: 'DNA',
      sourceExcerpt: 'Jądro komórkowe przechowuje DNA.',
      explanation: '',
    };
    const ctx = context();
    const first = parseGenerationResponse(JSON.stringify({ summary: '', cards: [card] }), ctx);
    const second = parseGenerationResponse(
      JSON.stringify({ summary: '', cards: [{ ...card, front: '  co PRZECHOWUJE jądro komórkowe?  ' }] }),
      ctx,
    );
    expect(first.cards).toHaveLength(1);
    expect(second.cards).toHaveLength(0);
    expect(second.rejected).toBe(1);
  });

  it('naprawia składnię luk, a gdy luki brak — degraduje typ do basic', () => {
    const raw = JSON.stringify({
      summary: '',
      cards: [
        {
          type: 'cloze',
          front: 'Mitochondria wytwarzają {c1::ATP} w procesie fosforylacji oksydacyjnej.',
          back: 'ATP',
          sourceExcerpt: 'Mitochondria wytwarzają ATP w procesie fosforylacji oksydacyjnej.',
          explanation: '',
        },
        {
          type: 'cloze',
          front: 'Jądro komórkowe przechowuje DNA.',
          back: 'DNA',
          sourceExcerpt: 'Jądro komórkowe przechowuje DNA.',
          explanation: '',
        },
      ],
    });
    const result = parseGenerationResponse(raw, context());
    expect(result.cards[0]?.type).toBe('cloze');
    expect(result.cards[0]?.front).toContain('{{c1::ATP}}');
    expect(result.cards[1]?.type).toBe('basic');
  });

  it('wymusza typy dozwolone przez użytkownika', () => {
    const raw = JSON.stringify({
      summary: '',
      cards: [
        {
          type: 'case',
          front: 'Pacjent skarży się na brak energii — jaka organella zawodzi?',
          back: 'Mitochondrium',
          sourceExcerpt: 'Mitochondria wytwarzają ATP w procesie fosforylacji oksydacyjnej.',
          explanation: '',
        },
      ],
    });
    const result = parseGenerationResponse(raw, context(['basic']));
    expect(result.cards[0]?.type).toBe('basic');
  });

  it('ignoruje śmieci w tablicy cards', () => {
    const raw = '{"summary":"ok","cards":[null, 42, "tekst"]}';
    const result = parseGenerationResponse(raw, context());
    expect(result.cards).toHaveLength(0);
    expect(result.summary).toBe('ok');
  });
});
