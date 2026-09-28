import { describe, expect, it } from 'vitest';

import { FIELD_LIMITS, buildCardGrammar, salvageTruncated, tokenBudget } from './grammar';

describe('buildCardGrammar', () => {
  it('fiszki przed kompendium, bez swobodnych białych znaków', () => {
    const grammar = buildCardGrammar(['basic', 'cloze'], 2);
    const root = grammar.split('\n')[0] ?? '';
    expect(root).toBe('root ::= "{\\"cards\\":[" card ("," card )? "],\\"summary\\":" summary "}"');
    expect(grammar).not.toMatch(/\bws\b|\[ \\t\\n\]/);
  });

  it('pozwala wyłącznie na wybrane typy', () => {
    expect(buildCardGrammar(['cloze'], 1)).toContain('type ::= "\\"cloze\\""');
    expect(buildCardGrammar(['basic', 'case'], 1)).toContain('type ::= "\\"basic\\"" | "\\"case\\""');
  });

  it('od 1 do N fiszek — pusta lista jest niemożliwa', () => {
    const grammar = buildCardGrammar(['basic'], 4);
    // Pierwsza fiszka jest obowiązkowa, kolejne trzy opcjonalne.
    expect(grammar).toContain('card ("," card ("," card ("," card )?)?)?');
    expect(buildCardGrammar(['basic'], 1).split('\n')[0]).toContain('[" card "],');
  });

  it('napisy w postaci z lookahead (szybkie maski), bez limitów długości w gramatyce', () => {
    const grammar = buildCardGrammar(['basic'], 1);
    expect(grammar).toContain('front ::= "\\"" str_body');
    expect(grammar).toContain('(=[,}])');
    // Zakresy {m,n} kosztowały setki ms na token — nie mogą wrócić.
    expect(grammar).not.toMatch(/\{\d+,\d+\}/);
  });

  it('liczba fiszek jest przycinana do rozsądnego zakresu', () => {
    expect(buildCardGrammar(['basic'], 0).split('\n')[0]).toContain('[" card "]');
    expect((buildCardGrammar(['basic'], 50).match(/"," card/g) ?? []).length).toBe(7);
  });
});

describe('tokenBudget', () => {
  it('mieści najdłuższą odpowiedź dopuszczalną przez gramatykę', () => {
    const perCard =
      FIELD_LIMITS.front + FIELD_LIMITS.back + FIELD_LIMITS.sourceExcerpt + FIELD_LIMITS.explanation;
    // Nawet przy pesymistycznych 2,5 znaku na token.
    expect(tokenBudget(2) * 2.5).toBeGreaterThanOrEqual(2 * perCard + FIELD_LIMITS.summary);
  });

  it('nie przekracza miejsca w oknie kontekstu (4096) przy dużej liczbie fiszek', () => {
    expect(tokenBudget(8)).toBeLessThanOrEqual(2600);
  });
});

describe('salvageTruncated', () => {
  const card = (front: string): Record<string, string> => ({
    type: 'basic',
    front,
    back: 'B',
    sourceExcerpt: 'Cytat',
    explanation: '',
  });

  it('ucięte w kompendium — zachowuje wszystkie fiszki', () => {
    const full = JSON.stringify({ cards: [card('A?'), card('B?')], summary: 'Długie kompendium' });
    const salvaged = salvageTruncated(full.slice(0, -10));
    expect(salvaged).not.toBeNull();
    expect((JSON.parse(salvaged ?? '') as { cards: unknown[] }).cards).toHaveLength(2);
  });

  it('ucięte w drugiej fiszce — zachowuje pierwszą', () => {
    const full = JSON.stringify({ cards: [card('A?'), card('Bardzo długie pytanie?')], summary: '' });
    const cut = full.slice(0, full.indexOf('Bardzo') + 5);
    const parsed = JSON.parse(salvageTruncated(cut) ?? '') as { cards: { front: string }[] };
    expect(parsed.cards.map((c) => c.front)).toEqual(['A?']);
  });

  it('klamra wewnątrz tekstu nie myli odzysku', () => {
    const full = JSON.stringify({ cards: [card('Luka {{c1::ATP}} w zdaniu')], summary: 'x' });
    const cut = full.slice(0, full.indexOf('ATP}}') + 4);
    expect(salvageTruncated(cut)).toBeNull();
  });

  it('brak choćby jednej domkniętej fiszki — null', () => {
    expect(salvageTruncated('{"cards":[{"type":"basic","front":"Co')).toBeNull();
    expect(salvageTruncated('coś zupełnie innego')).toBeNull();
  });
});
