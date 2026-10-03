import type { DraftCard } from './db';

/**
 * Testy jednokrotnego/wielokrotnego wyboru z kluczem odpowiedzi
 * („1. Pytanie: a. … b. … c. … Odpowiedzi: 1a, 2c, 3-, 4ab”).
 *
 * Model językowy czytający taki materiał we fragmentach nie potrafi rzetelnie
 * połączyć pytań z kluczem: gubi pytania, myli odpowiedzi, robi fiszki z
 * pojedynczych opcji. Ten format da się jednak rozłożyć deterministycznie —
 * każde pytanie z kluczem staje się jedną fiszką, bez pomijania i bez AI
 * (działa więc także tam, gdzie model się nie mieści, np. na iPhonie).
 */

export interface QuizOption {
  letter: string;
  text: string;
}

export interface QuizQuestion {
  number: number;
  stem: string;
  options: QuizOption[];
  /** Litery poprawnych odpowiedzi; pusta tablica = „żadna” (w kluczu „-”). */
  correct: string[];
  /** Tekst pytania z opcjami w postaci ze źródła (cytat źródłowy fiszki). */
  source: string;
}

export interface QuizParseResult {
  questions: QuizQuestion[];
  /** Pozycje klucza, których pytania nie udało się odczytać. */
  missing: number[];
}

/**
 * Znaki wodne serwisów z notatkami, wklejone w tekst przy eksporcie PDF
 * („Downloaded by Jan Kowalski (jan@example.com)”, „lOMoARcPSD|33932464”).
 * Bez usunięcia trafiają do pytań, odpowiedzi i fragmentów dla modelu.
 */
const WATERMARKS = [
  /Downloaded by [^()\n]{1,80}\([^()\s]+@[^()\s]+\)/gi,
  /Pobrane przez [^()\n]{1,80}\([^()\s]+@[^()\s]+\)/gi,
  /lOMoARcPSD\|\d+/g,
  /Studocu is not sponsored or endorsed by any college or university/gi,
];

export function stripWatermarks(text: string): string {
  let result = text;
  for (const pattern of WATERMARKS) result = result.replace(pattern, ' ');
  return result.replace(/[ \t]{2,}/g, ' ');
}

/** „Odpowiedzi: 1a,2c, 3-, 4ab” — także „Klucz odpowiedzi”, „Odp.”. */
const ANSWER_KEY = /(?:klucz\s+odpowiedzi|odpowiedzi|odp\.)\s*:?\s*((?:\d{1,3}\s*(?:[a-h]+|-)\s*[,;]?\s*){3,})/gi;
const KEY_ENTRY = /(\d{1,3})\s*([a-h]+|-)/gi;

function parseKey(raw: string): Map<number, string[]> {
  const key = new Map<number, string[]>();
  for (const match of raw.matchAll(KEY_ENTRY)) {
    const number = Number(match[1]);
    const letters = (match[2] ?? '').toLowerCase();
    key.set(number, letters === '-' ? [] : [...new Set(letters)]);
  }
  return key;
}

/**
 * Początki pytań szukamy kolejno (1, 2, 3…): numer musi stać po spacji/początku
 * i przed wielką literą albo cudzysłowem. Dzięki kolejności „art. 2. ustawy”
 * w treści pytania 1 nie rozbije go — szukamy tylko numeru, który ma przyjść.
 */
function findQuestionStarts(block: string, numbers: number[]): { number: number; index: number; bodyStart: number }[] {
  const starts: { number: number; index: number; bodyStart: number }[] = [];
  let from = 0;
  for (const number of numbers) {
    // Najpierw ostrożnie (wielka litera po numerze), potem dowolna litera —
    // bywają testy, w których pytanie zaczyna się małą literą.
    let match: RegExpExecArray | null = null;
    for (const next of ['[\\p{Lu}„"«(]', '\\p{L}']) {
      const pattern = new RegExp(`(^|\\s)${number}\\s*[.)]\\s+(?=${next})`, 'gu');
      pattern.lastIndex = from;
      match = pattern.exec(block);
      if (match !== null) break;
    }
    if (match === null) continue;
    const index = match.index + (match[1]?.length ?? 0);
    starts.push({ number, index, bodyStart: match.index + match[0].length });
    from = match.index + match[0].length;
  }
  return starts;
}

/** Opcje „a. …”, „b) …” — kolejne litery, każda po spacji. */
function splitOptions(body: string): { stem: string; options: QuizOption[] } | null {
  const letters = 'abcdefgh';
  const positions: { letter: string; index: number; textStart: number }[] = [];
  let from = 0;
  for (const letter of letters) {
    const pattern = new RegExp(`(^|\\s)${letter}\\s*[.)]\\s+`, 'g');
    pattern.lastIndex = from;
    const match = pattern.exec(body);
    if (match === null) break;
    positions.push({ letter, index: match.index, textStart: match.index + match[0].length });
    from = match.index + match[0].length;
  }
  if (positions.length < 2) return null;

  const stem = body.slice(0, positions[0]?.index ?? 0).trim();
  const options = positions.map((position, i) => ({
    letter: position.letter,
    text: body.slice(position.textStart, positions[i + 1]?.index ?? body.length).trim(),
  }));
  if (stem.length === 0 || options.some((option) => option.text.length === 0)) return null;
  return { stem, options };
}

export function parseQuiz(rawText: string): QuizParseResult {
  const text = stripWatermarks(rawText).replace(/\s+/g, ' ');
  const questions: QuizQuestion[] = [];
  const missing: number[] = [];

  let blockStart = 0;
  for (const keyMatch of text.matchAll(ANSWER_KEY)) {
    const block = text.slice(blockStart, keyMatch.index);
    blockStart = (keyMatch.index ?? 0) + keyMatch[0].length;

    const key = parseKey(keyMatch[1] ?? '');
    const numbers = [...key.keys()].sort((a, b) => a - b);
    const starts = findQuestionStarts(block, numbers);
    const found = new Set<number>();

    starts.forEach((start, i) => {
      const end = starts[i + 1]?.index ?? block.length;
      const body = block.slice(start.bodyStart, end).trim();
      const parsed = splitOptions(body);
      const correct = key.get(start.number) ?? [];
      if (parsed === null) return;
      // Klucz wskazuje literę, której nie ma wśród opcji — pytanie odczytane źle.
      if (correct.some((letter) => !parsed.options.some((option) => option.letter === letter))) return;
      found.add(start.number);
      questions.push({
        number: start.number,
        stem: parsed.stem,
        options: parsed.options,
        correct,
        source: block.slice(start.index, end).trim(),
      });
    });

    for (const number of numbers) if (!found.has(number)) missing.push(number);
  }

  return { questions, missing };
}

/**
 * Czy materiał to test z kluczem: co najmniej 3 pytania i odczytana większość
 * pozycji klucza (inaczej to raczej przypadkowe dopasowanie).
 */
export function detectQuiz(rawText: string): QuizParseResult | null {
  const result = parseQuiz(rawText);
  const total = result.questions.length + result.missing.length;
  if (result.questions.length < 3 || result.questions.length / total < 0.6) return null;
  return result;
}

export function quizQuestionToCard(question: QuizQuestion): DraftCard {
  const options = question.options.map((option) => `${option.letter}) ${option.text}`).join('\n');
  const correct = question.options.filter((option) => question.correct.includes(option.letter));
  const back =
    correct.length === 0
      ? 'Żadna z odpowiedzi nie jest prawidłowa.'
      : correct.map((option) => `${option.letter}) ${option.text}`).join('\n');
  return {
    type: 'basic',
    front: `${question.stem}\n${options}`,
    back,
    sourceExcerpt: question.source,
    explanation: `Klucz odpowiedzi: ${question.number}${question.correct.join('') || '-'}`,
    verified: true,
  };
}
