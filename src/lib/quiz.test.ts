import { describe, expect, it } from 'vitest';

import { detectQuiz, parseQuiz, quizQuestionToCard, stripWatermarks } from './quiz';

/**
 * Format z raportu użytkownika: tekst z PDF spłaszczony do jednej linii,
 * numery pytań w środku zdań, znaki wodne serwisu z notatkami, klucz na końcu.
 * Pytania 15–20 i klucz przepisane ze zrzutu ekranu; dane osobowe zmienione.
 */
const WATERMARK = 'Downloaded by Jan Kowalski (jan.kowalski@example.com) lOMoARcPSD|33932464';
const QUESTIONS_1_14 = Array.from({ length: 14 }, (_, i) => {
  const n = i + 1;
  if (n === 1) {
    return '1. Domniemanie kompetencji na rzecz organu wykonawczego jednostki samorządu terytorialnego występuje na poziomie: a. gminy b. powiatu c. województwa';
  }
  if (n === 7) {
    // Znak wodny w środku pytania (łamanie strony w PDF).
    return `7. Wójt: a. Jest organem wykonawczym gminy ${WATERMARK} b. Jest organem rady gminy c. Jest wybierany przez radę gminy`;
  }
  return `${n}. Pytanie numer ${n} o ustrój samorządu: a. Pierwsza możliwość ${n} b. Druga możliwość ${n} c. Trzecia możliwość ${n}`;
}).join(' ');

const MATERIAL = `${WATERMARK} Test z samorządu terytorialnego ${QUESTIONS_1_14} 15. Skarbnik powiatu: a. Jest powoływany przez starostę b. Jest powoływany przez radę powiatu na wniosek starosty c. Może uczestniczyć w pracach rady powiatu 16. Uchwały rady powiatu: a. Są zatwierdzane przez starostę b. Są przedkładane wojewodzie przez starostę w terminie 7 dni od ich publikacji c. Są podejmowane w głosowaniu tajnym 17. W razie powtarzającego się naruszania przez sejmik województwa Konstytucji lub ustaw: a. Prezes Rady ministrów może w drodze uchwały rozwiązać sejmik b. Sejm, na wniosek wojewody, może w drodze uchwały rozwiązać sejmik c. Wojewoda może rozwiązać sejmik w drodze zarządzenia 18. W przypadku nieistotnego naruszenia prawa: a. Organ nadzoru stwierdza nieważność uchwały b. Organ nadzoru wzywa radę do usunięcia naruszenia c. Organ nadzoru stwierdza, że uchwałę wydano z naruszeniem prawa 19. Po upływie roku od dnia podjęcia uchwały: a. Nigdy nie jest możliwe stwierdzenie jej nieważności b. Jest ona bezwzględnie wiążąca c. Może być ona zaskarżona do sądu administracyjnego przez każdego obywatela, którego interes faktyczny uchwała narusza 20. Po upływie kadencji wójta: a. Pełni on swoją funkcję do czasu objęcia obowiązków przez nowo wybranego wójta b. Pełni on swoją funkcję do dnia ogłoszenia wyników wyborów c. Pełni on swoją funkcję jeszcze przez okres 30 dni Odpowiedzi: 1a,2c, 3-, 4ab, 5abc, 6bc, 7a, 8ac, 9b, 10bc, 11c, 12c, 13c, 14b, 15bc, 16-, 17-, 18c, 19-, 20a ${WATERMARK}`;

describe('parseQuiz — test z kluczem z raportu użytkownika', () => {
  const result = parseQuiz(MATERIAL);

  it('odczytuje wszystkie 20 pytań — nic nie jest pomijane', () => {
    expect(result.questions.map((q) => q.number)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(result.missing).toEqual([]);
  });

  it('łączy pytania z kluczem, także „-” (żadna) i wiele poprawnych', () => {
    const byNumber = new Map(result.questions.map((q) => [q.number, q]));
    expect(byNumber.get(1)?.correct).toEqual(['a']);
    expect(byNumber.get(15)?.correct).toEqual(['b', 'c']);
    expect(byNumber.get(16)?.correct).toEqual([]);
    expect(byNumber.get(5)?.correct).toEqual(['a', 'b', 'c']);
  });

  it('rozdziela treść pytania i opcje (bez doklejonego następnego numeru)', () => {
    const q15 = result.questions.find((q) => q.number === 15);
    expect(q15?.stem).toBe('Skarbnik powiatu:');
    expect(q15?.options.map((o) => o.text)).toEqual([
      'Jest powoływany przez starostę',
      'Jest powoływany przez radę powiatu na wniosek starosty',
      'Może uczestniczyć w pracach rady powiatu',
    ]);
    const q20 = result.questions.find((q) => q.number === 20);
    expect(q20?.options[2]?.text).toBe('Pełni on swoją funkcję jeszcze przez okres 30 dni');
  });

  it('usuwa znaki wodne — także w środku pytania', () => {
    const q7 = result.questions.find((q) => q.number === 7);
    expect(q7?.options[0]?.text).toBe('Jest organem wykonawczym gminy');
    for (const q of result.questions) {
      expect(`${q.stem} ${q.options.map((o) => o.text).join(' ')}`).not.toMatch(/Downloaded|lOMoAR|@/);
    }
  });

  it('liczby w treści („w terminie 7 dni”) nie rozbijają pytań', () => {
    const q16 = result.questions.find((q) => q.number === 16);
    expect(q16?.options[1]?.text).toBe('Są przedkładane wojewodzie przez starostę w terminie 7 dni od ich publikacji');
  });
});

describe('quizQuestionToCard', () => {
  const questions = parseQuiz(MATERIAL).questions;

  it('fiszka: pytanie z opcjami na awersie, poprawne odpowiedzi na rewersie', () => {
    const card = quizQuestionToCard(questions.find((q) => q.number === 15)!);
    expect(card.front).toBe(
      'Skarbnik powiatu:\na) Jest powoływany przez starostę\nb) Jest powoływany przez radę powiatu na wniosek starosty\nc) Może uczestniczyć w pracach rady powiatu',
    );
    expect(card.back).toBe('b) Jest powoływany przez radę powiatu na wniosek starosty\nc) Może uczestniczyć w pracach rady powiatu');
    expect(card.explanation).toBe('Klucz odpowiedzi: 15bc');
    expect(card.verified).toBe(true);
  });

  it('„-” w kluczu daje jasną odpowiedź „żadna”', () => {
    expect(quizQuestionToCard(questions.find((q) => q.number === 19)!).back).toBe(
      'Żadna z odpowiedzi nie jest prawidłowa.',
    );
  });

  it('awers nigdy nie jest równy rewersowi (błąd fiszek z AI)', () => {
    for (const q of questions) {
      const card = quizQuestionToCard(q);
      expect(card.front).not.toBe(card.back);
    }
  });
});

describe('detectQuiz', () => {
  it('rozpoznaje test z kluczem', () => {
    expect(detectQuiz(MATERIAL)?.questions).toHaveLength(20);
  });

  it('nie myli zwykłych notatek z testem', () => {
    const notes =
      'Krzywa zapominania. Ebbinghaus wykazał w 1885 roku, że materiał zanika wykładniczo. 1. Powtórki pomagają. 2. Testowanie jest skuteczniejsze niż czytanie.';
    expect(detectQuiz(notes)).toBeNull();
  });

  it('kilka testów w jednym pliku, każdy z własnym kluczem i numeracją od 1', () => {
    const block = (topic: string): string =>
      [1, 2, 3].map((n) => `${n}. ${topic} pytanie ${n}: a. Tak ${n} b. Nie ${n}`).join(' ');
    const twoTests = `${block('Gmina')} Odpowiedzi: 1a, 2b, 3a ${block('Powiat')} Odpowiedzi: 1b, 2a, 3-`;
    const result = detectQuiz(twoTests);
    expect(result?.questions).toHaveLength(6);
    expect(result?.questions[3]?.stem).toBe('Powiat pytanie 1:');
    expect(result?.questions[3]?.correct).toEqual(['b']);
  });
});

describe('stripWatermarks', () => {
  it('usuwa znaki wodne serwisów z notatkami', () => {
    expect(stripWatermarks(`Treść ${WATERMARK} dalej`).replace(/\s+/g, ' ')).toBe('Treść dalej');
  });
});

describe('parseQuiz — pytania zaczynające się małą literą', () => {
  it('odczytuje je dzięki drugiemu, mniej ostrożnemu przebiegowi', () => {
    const text = '1. kto powołuje skarbnika: a. starosta b. rada 2. ile trwa kadencja: a. 4 lata b. 5 lat 3. kto zwołuje sesję: a. przewodniczący b. wójt Odpowiedzi: 1b, 2b, 3a';
    expect(parseQuiz(text).questions.map((q) => q.stem)).toEqual([
      'kto powołuje skarbnika:',
      'ile trwa kadencja:',
      'kto zwołuje sesję:',
    ]);
  });
});
