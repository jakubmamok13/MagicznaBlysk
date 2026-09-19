import { describe, expect, it } from 'vitest';
import { chunkText, countWords, splitIntoSentences, verifyExcerpt } from './text';
import { extractDeletions, hasCloze, maskCloze, repairClozeSyntax, revealCloze } from './cloze';

describe('chunkText', () => {
  it('zwraca jeden fragment dla krótkiego tekstu', () => {
    const chunks = chunkText('Krótki materiał do nauki.', 2000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe('Krótki materiał do nauki.');
  });

  it('nigdy nie przekracza limitu znaków', () => {
    const paragraph = 'Zdanie testowe o mitochondriach i ich funkcji w komórce. '.repeat(40);
    const chunks = chunkText(paragraph, 400);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(400);
    }
  });

  it('numeruje fragmenty rosnąco', () => {
    const chunks = chunkText(['Akapit pierwszy.', 'Akapit drugi.', 'Akapit trzeci.'].join('\n\n'), 20);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
  });

  it('zwraca pustą listę dla pustego wejścia', () => {
    expect(chunkText('   \n\n  ')).toEqual([]);
  });
});

describe('splitIntoSentences', () => {
  it('nie dzieli tekstu na polskich skrótach', () => {
    const sentences = splitIntoSentences('Badanie objęło m.in. studentów. Wyniki były jasne.');
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toBe('Badanie objęło m.in. studentów.');
  });
});

describe('verifyExcerpt', () => {
  const source =
    'Mitochondria wytwarzają ATP w procesie fosforylacji oksydacyjnej. Rybosomy odpowiadają za syntezę białek.';

  it('rozpoznaje cytat dosłowny', () => {
    const result = verifyExcerpt('Rybosomy odpowiadają za syntezę białek.', source);
    expect(result.verbatim).toBe(true);
  });

  it('ignoruje różnice w spacjach i cudzysłowach', () => {
    const result = verifyExcerpt('„Mitochondria   wytwarzają ATP w procesie fosforylacji oksydacyjnej.”', source);
    expect(result.verbatim).toBe(true);
  });

  it('podmienia zmyślony cytat na najbliższe zdanie źródłowe', () => {
    const result = verifyExcerpt('Mitochondria produkują ATP dzięki fosforylacji oksydacyjnej w komórce', source);
    expect(result.verbatim).toBe(false);
    expect(result.excerpt).toBe('Mitochondria wytwarzają ATP w procesie fosforylacji oksydacyjnej.');
  });

  it('zwraca pusty cytat dla pustego wejścia', () => {
    const result = verifyExcerpt('   ', source);
    expect(result.excerpt).toBe('');
    expect(result.matched).toBe(false);
  });

  it('dopasowuje cytat mimo polskiej fleksji', () => {
    const result = verifyExcerpt('Rybosomy biorą udział w syntezie białek w komórce', source);
    expect(result.matched).toBe(true);
    expect(result.excerpt).toBe('Rybosomy odpowiadają za syntezę białek.');
  });

  it('odrzuca cytat bez pokrycia w źródle (konfabulacja)', () => {
    const result = verifyExcerpt('Zupełnie inny temat, np. historia średniowiecznej Europy.', source);
    expect(result.matched).toBe(false);
    expect(result.excerpt).toBe('');
  });
});

describe('cloze', () => {
  it('wykrywa i wypakowuje luki', () => {
    const text = 'Stolicą Polski jest {{c1::Warszawa}}, a największą rzeką {{c2::Wisła}}.';
    expect(hasCloze(text)).toBe(true);
    expect(extractDeletions(text).map((d) => d.answer)).toEqual(['Warszawa', 'Wisła']);
    expect(maskCloze(text)).toBe('Stolicą Polski jest […], a największą rzeką […].');
    expect(revealCloze(text)).toBe('Stolicą Polski jest Warszawa, a największą rzeką Wisła.');
  });

  it('obsługuje podpowiedzi', () => {
    const deletions = extractDeletions('Enzym {{c1::amylaza::nazwa enzymu}} rozkłada skrobię.');
    expect(deletions[0]?.hint).toBe('nazwa enzymu');
    expect(maskCloze('Enzym {{c1::amylaza::nazwa enzymu}} rozkłada skrobię.')).toContain('nazwa enzymu');
  });

  it('naprawia błędną składnię modelu', () => {
    expect(repairClozeSyntax('Pierwiastek {c1::wodór} jest najlżejszy.')).toBe(
      'Pierwiastek {{c1::wodór}} jest najlżejszy.',
    );
    expect(repairClozeSyntax('{{c1:tlen}} to gaz.')).toBe('{{c1::tlen}} to gaz.');
    expect(repairClozeSyntax('Brak luk w tym zdaniu.')).toBeNull();
  });
});

describe('countWords', () => {
  it('liczy słowa z polskimi znakami', () => {
    expect(countWords('Zażółć gęślą jaźń — trzy słowa?')).toBe(5);
  });
});
