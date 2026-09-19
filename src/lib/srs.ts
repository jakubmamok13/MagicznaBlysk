import type { Flashcard } from './db';

/* -------------------------------------------------------------------------- */
/*                             Algorytm SM-2 (SRS)                            */
/* -------------------------------------------------------------------------- */

/** Ocena odpowiedzi: 1 = całkowity blackout, 5 = perfekcyjna odpowiedź. */
export type ReviewQuality = 1 | 2 | 3 | 4 | 5;

/** Minimalny dopuszczalny współczynnik łatwości w SM-2. */
export const MIN_EASE_FACTOR = 1.3;

/** Startowy współczynnik łatwości dla nowej fiszki. */
export const DEFAULT_EASE_FACTOR = 2.5;

/** Próg oceny, od którego odpowiedź uznajemy za poprawną. */
export const PASSING_QUALITY = 3;

/** Po tylu nieudanych powtórkach fiszka jest oznaczana jako „leech”. */
export const LEECH_THRESHOLD = 4;

export interface SM2Result {
  /** Nowy odstęp w dniach. */
  interval: number;
  /** Nowa liczba poprawnych powtórek pod rząd. */
  repetitions: number;
  /** Nowy współczynnik łatwości (>= 1.3). */
  easeFactor: number;
  /** 1 gdy należy zwiększyć `leechCount`, w przeciwnym razie 0. */
  leechIncrement: 0 | 1;
  /** Czy odpowiedź została uznana za poprawną (ocena >= 3). */
  passed: boolean;
}

/**
 * Czysta implementacja algorytmu SuperMemo 2.
 *
 * Funkcja jest w pełni deterministyczna i nie ma efektów ubocznych —
 * stan fiszki aktualizuje dopiero `applyReview`.
 *
 * @param quality ocena odpowiedzi w skali 1–5 (wartości poza skalą są przycinane)
 * @param repetitions liczba poprawnych powtórek pod rząd przed tą oceną
 * @param previousInterval poprzedni odstęp w dniach
 * @param previousEaseFactor poprzedni współczynnik łatwości
 */
export function calculateSM2(
  quality: number,
  repetitions: number,
  previousInterval: number,
  previousEaseFactor: number,
): SM2Result {
  const q = clampQuality(quality);
  const safeRepetitions = Number.isFinite(repetitions) ? Math.max(0, Math.trunc(repetitions)) : 0;
  const safeInterval = Number.isFinite(previousInterval) ? Math.max(0, previousInterval) : 0;
  const safeEase = Number.isFinite(previousEaseFactor)
    ? Math.max(MIN_EASE_FACTOR, previousEaseFactor)
    : DEFAULT_EASE_FACTOR;

  // Współczynnik łatwości aktualizujemy zawsze — również po błędnej odpowiedzi.
  const easeFactor = Math.max(
    MIN_EASE_FACTOR,
    safeEase + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)),
  );

  // Ocena < 3 → fiszka wraca na początek kolejki nauki.
  if (q < PASSING_QUALITY) {
    return {
      interval: 1,
      repetitions: 0,
      easeFactor: roundEase(easeFactor),
      leechIncrement: 1,
      passed: false,
    };
  }

  let interval: number;
  if (safeRepetitions === 0) {
    interval = 1;
  } else if (safeRepetitions === 1) {
    interval = 6;
  } else {
    interval = Math.round(safeInterval * safeEase);
  }

  return {
    interval: Math.max(1, interval),
    repetitions: safeRepetitions + 1,
    easeFactor: roundEase(easeFactor),
    leechIncrement: 0,
    passed: true,
  };
}

function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return 1;
  return Math.min(5, Math.max(1, Math.round(quality)));
}

/** Ucinamy do 3 miejsc, by uniknąć kumulacji błędu zmiennoprzecinkowego. */
function roundEase(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/* -------------------------------------------------------------------------- */
/*                        Zastosowanie oceny do fiszki                        */
/* -------------------------------------------------------------------------- */

export type CardSchedulingFields = Pick<
  Flashcard,
  'interval' | 'repetitions' | 'easeFactor' | 'dueDate' | 'leechCount'
>;

/** Dodaje `days` dni do daty (bez mutacji argumentu). */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

/** Początek dnia — używany do liczenia „na dziś”. */
export function startOfDay(date: Date = new Date()): Date {
  const result = new Date(date.getTime());
  result.setHours(0, 0, 0, 0);
  return result;
}

export function endOfDay(date: Date = new Date()): Date {
  const result = new Date(date.getTime());
  result.setHours(23, 59, 59, 999);
  return result;
}

/**
 * Wylicza nowy stan harmonogramu fiszki po ocenie.
 * Zwraca wyłącznie pola do zapisania w bazie.
 */
export function applyReview(
  card: Pick<Flashcard, 'interval' | 'repetitions' | 'easeFactor' | 'leechCount'>,
  quality: number,
  now: Date = new Date(),
): CardSchedulingFields & { passed: boolean } {
  const result = calculateSM2(quality, card.repetitions, card.interval, card.easeFactor);
  return {
    interval: result.interval,
    repetitions: result.repetitions,
    easeFactor: result.easeFactor,
    dueDate: addDays(now, result.interval),
    leechCount: card.leechCount + result.leechIncrement,
    passed: result.passed,
  };
}

/** Czy fiszka wymaga interwencji użytkownika (zbyt wiele pomyłek). */
export function isLeech(card: Pick<Flashcard, 'leechCount'>): boolean {
  return card.leechCount >= LEECH_THRESHOLD;
}

/* -------------------------------------------------------------------------- */
/*                          Przyciski oceny w widoku nauki                    */
/* -------------------------------------------------------------------------- */

export type RatingKey = 'again' | 'hard' | 'good' | 'easy';

export interface RatingOption {
  key: RatingKey;
  /** Klawisz skrótu (1–4). */
  shortcut: '1' | '2' | '3' | '4';
  label: string;
  quality: ReviewQuality;
}

/**
 * Mapowanie czterech przycisków na skalę SM-2 1–5.
 * „Znowu” musi być < 3, aby zresetować licznik powtórek.
 */
export const RATING_OPTIONS: readonly RatingOption[] = [
  { key: 'again', shortcut: '1', label: 'Znowu', quality: 1 },
  { key: 'hard', shortcut: '2', label: 'Trudne', quality: 3 },
  { key: 'good', shortcut: '3', label: 'Dobre', quality: 4 },
  { key: 'easy', shortcut: '4', label: 'Łatwe', quality: 5 },
] as const;

/** Podpowiedź „następna powtórka za …” wyświetlana na przyciskach oceny. */
export function previewInterval(
  card: Pick<Flashcard, 'interval' | 'repetitions' | 'easeFactor'>,
  quality: number,
): number {
  return calculateSM2(quality, card.repetitions, card.interval, card.easeFactor).interval;
}

/** Formatuje odstęp w dniach na czytelny polski tekst. */
export function formatInterval(days: number): string {
  if (days <= 0) return 'dziś';
  if (days === 1) return '1 dzień';
  if (days < 30) return `${days} dni`;
  const months = Math.round(days / 30);
  if (months === 1) return '1 miesiąc';
  if (months < 5) return `${months} miesiące`;
  if (months < 12) return `${months} miesięcy`;
  const years = Math.round(days / 365);
  return years === 1 ? '1 rok' : `${years} lat`;
}
