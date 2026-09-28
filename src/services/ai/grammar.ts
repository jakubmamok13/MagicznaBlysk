import type { CardType } from '@/lib/db';

/**
 * Gramatyka odpowiedzi modelu (EBNF dla xgrammar, `response_format: grammar`).
 *
 * Dlaczego nie `json_object` + schemat: WebLLM kompiluje schemat z dowolną
 * liczbą białych znaków między elementami JSON, bez limitu. Małe modele
 * potrafią wtedy „utknąć” na spacjach i nowych liniach aż do wyczerpania
 * limitu tokenów — odpowiedź jest ucięta w połowie i nie da się jej odczytać.
 * Do tego schemat bez `minItems` pozwalał na pustą listę fiszek.
 *
 * Tu kontrolujemy wszystko:
 * - zero swobodnych białych znaków — JSON w formie kanonicznej,
 * - od 1 do `maxCards` fiszek (pusta lista jest niemożliwa),
 * - fiszki PRZED kompendium — gdy zabraknie tokenów, ucina się kompendium,
 *   a nie fiszki,
 *
 * Długości pól NIE są ograniczane w gramatyce: zakres `char{0,700}` xgrammar
 * rozwija w setki zagnieżdżonych reguł, których maski tokenów nie da się
 * wyliczyć z góry — pomiar na prawdziwym słowniku Qwen dał ~836 ms na KAŻDY
 * token (wobec ~0,05 ms dla `char*`). Rozmiar odpowiedzi ogranicza budżet
 * tokenów, a uciętą odpowiedź ratuje `salvageTruncated()`.
 */

/**
 * Oczekiwane maksymalne długości pól (znaki) — podstawa budżetu tokenów.
 * Model dostaje w prompcie prośbę o zwięzłość; gramatyka ich nie wymusza.
 */
export const FIELD_LIMITS = {
  front: 220,
  back: 260,
  sourceExcerpt: 300,
  explanation: 200,
  summary: 700,
} as const;

/**
 * Napis JSON w tej samej postaci, jakiej używa konwerter schematów xgrammar:
 * prawostronna rekurencja + lookahead `(=[,}])` mówiący, co stoi po cudzysłowie
 * zamykającym. Dzięki temu maski tokenów wewnątrz napisu są wyliczane z góry.
 * Prostsze `char*` działało poprawnie, ale kosztowało ~85 ms na każdy token
 * (pomiar na słowniku Qwen) — generowanie byłoby setki razy wolniejsze.
 * U nas po każdym napisie stoi `,` albo `}`.
 */
const STRING_RULES = [
  String.raw`str_body ::= ("\"" | [^\0-\x1f"\\\r\n] str_body | "\\" escape str_body) (=[,}])`,
  String.raw`escape ::= ["\\/bfnrt] | "u" [A-Fa-f0-9] [A-Fa-f0-9] [A-Fa-f0-9] [A-Fa-f0-9]`,
];

/**
 * Każde pole to ten sam szybki napis. Wymuszanie niepustego pola w gramatyce
 * (pierwszy znak osobną regułą) kosztowało ~46 ms na pole — puste pola i tak
 * odrzuca walidacja w `schema.ts`.
 */
function stringRule(name: string): string {
  return String.raw`${name} ::= "\"" str_body`;
}

/** `"basic" | "cloze"` — dozwolone typy jako literały. */
function typeAlternatives(allowedTypes: readonly CardType[]): string {
  const types = allowedTypes.length > 0 ? allowedTypes : (['basic'] as const);
  return types.map((type) => `"\\"${type}\\""`).join(' | ');
}

/**
 * Od 1 do `maxCards` fiszek jako zagnieżdżone opcje — działa w każdej wersji
 * parsera EBNF (nie wymaga zakresów powtórzeń dla reguł złożonych).
 */
function cardsSequence(maxCards: number): string {
  let tail = '';
  for (let index = 1; index < maxCards; index += 1) {
    tail = `("," card ${tail})?`;
  }
  return `card ${tail}`.trim();
}

export function buildCardGrammar(allowedTypes: readonly CardType[], maxCards: number): string {
  const count = Math.max(1, Math.min(8, Math.round(maxCards)));
  return [
    `root ::= "{\\"cards\\":[" ${cardsSequence(count)} "],\\"summary\\":" summary "}"`,
    'card ::= "{\\"type\\":" type ",\\"front\\":" front ",\\"back\\":" back ",\\"sourceExcerpt\\":" excerpt ",\\"explanation\\":" explanation "}"',
    `type ::= ${typeAlternatives(allowedTypes)}`,
    stringRule('front'),
    stringRule('back'),
    stringRule('excerpt'),
    stringRule('explanation'),
    stringRule('summary'),
    ...STRING_RULES,
  ].join('\n');
}

/**
 * Budżet tokenów pokrywający odpowiedź z polami o oczekiwanej długości
 * (polski tekst to średnio ~3 znaki na token; liczymy ostrożnie po 2,5).
 * Dłuższą odpowiedź utnie limit — kompletne fiszki odzyska `salvageTruncated()`.
 */
const MAX_OUTPUT_TOKENS = 2600;

export function tokenBudget(maxCards: number): number {
  const perCard =
    FIELD_LIMITS.front + FIELD_LIMITS.back + FIELD_LIMITS.sourceExcerpt + FIELD_LIMITS.explanation;
  const chars = maxCards * (perCard + 80) + FIELD_LIMITS.summary + 40;
  // Okno kontekstu to 4096 tokenów, a prompt z fragmentem zajmuje do ~1300 —
  // przy 6–8 fiszkach nie obiecujemy więcej, niż się zmieści.
  return Math.min(MAX_OUTPUT_TOKENS, Math.ceil(chars / 2.5));
}

/**
 * Odzyskuje kompletne fiszki z odpowiedzi uciętej limitem tokenów.
 * Gramatyka gwarantuje kanoniczny JSON bez białych znaków, więc wystarczy
 * znaleźć ostatnią domkniętą fiszkę i dokleić zamknięcie tablicy.
 */
export function salvageTruncated(raw: string): string | null {
  const prefix = '{"cards":[';
  if (!raw.startsWith(prefix)) return null;

  for (let end = raw.lastIndexOf('}'); end > prefix.length; end = raw.lastIndexOf('}', end - 1)) {
    const candidate = `${raw.slice(0, end + 1)}],"summary":""}`;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === 'object' && parsed !== null) return candidate;
    } catch {
      // Ta klamra zamyka coś w środku napisu — szukamy wcześniejszej.
    }
  }
  return null;
}
