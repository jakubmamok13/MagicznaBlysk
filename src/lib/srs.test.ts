import { describe, expect, it } from 'vitest';
import {
  addDays,
  applyReview,
  calculateSM2,
  DEFAULT_EASE_FACTOR,
  formatInterval,
  MIN_EASE_FACTOR,
  previewInterval,
} from './srs';

describe('calculateSM2', () => {
  it('ustawia odstęp 1 dnia dla pierwszej poprawnej powtórki', () => {
    const result = calculateSM2(4, 0, 0, DEFAULT_EASE_FACTOR);
    expect(result.interval).toBe(1);
    expect(result.repetitions).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.leechIncrement).toBe(0);
  });

  it('ustawia odstęp 6 dni dla drugiej poprawnej powtórki', () => {
    const result = calculateSM2(4, 1, 1, DEFAULT_EASE_FACTOR);
    expect(result.interval).toBe(6);
    expect(result.repetitions).toBe(2);
  });

  it('mnoży poprzedni odstęp przez ease factor od trzeciej powtórki', () => {
    const result = calculateSM2(4, 2, 6, 2.5);
    expect(result.interval).toBe(15); // round(6 * 2.5)
    expect(result.repetitions).toBe(3);
  });

  it('resetuje powtórki i zwiększa leechCount przy ocenie < 3', () => {
    const result = calculateSM2(2, 7, 240, 2.5);
    expect(result.interval).toBe(1);
    expect(result.repetitions).toBe(0);
    expect(result.leechIncrement).toBe(1);
    expect(result.passed).toBe(false);
  });

  it('nie schodzi z ease factor poniżej 1.3', () => {
    let ease = DEFAULT_EASE_FACTOR;
    for (let i = 0; i < 20; i += 1) {
      ease = calculateSM2(1, 0, 1, ease).easeFactor;
    }
    expect(ease).toBe(MIN_EASE_FACTOR);
  });

  it('stosuje wzór SM-2 na ease factor', () => {
    // q=5 → EF + (0.1 - 0 * (0.08 + 0)) = EF + 0.1
    expect(calculateSM2(5, 1, 6, 2.5).easeFactor).toBeCloseTo(2.6, 5);
    // q=4 → EF + (0.1 - 1 * (0.08 + 0.02)) = EF + 0
    expect(calculateSM2(4, 1, 6, 2.5).easeFactor).toBeCloseTo(2.5, 5);
    // q=3 → EF + (0.1 - 2 * (0.08 + 0.04)) = EF - 0.14
    expect(calculateSM2(3, 1, 6, 2.5).easeFactor).toBeCloseTo(2.36, 5);
  });

  it('przycina oceny poza skalą i odporny jest na NaN', () => {
    expect(calculateSM2(99, 0, 0, 2.5).passed).toBe(true);
    expect(calculateSM2(-5, 0, 0, 2.5).passed).toBe(false);
    expect(calculateSM2(Number.NaN, 0, 0, Number.NaN).easeFactor).toBeGreaterThanOrEqual(
      MIN_EASE_FACTOR,
    );
  });
});

describe('applyReview', () => {
  const base = { interval: 6, repetitions: 2, easeFactor: 2.5, leechCount: 0 };

  it('planuje termin na dziś + odstęp', () => {
    const now = new Date('2026-01-10T08:00:00.000Z');
    const result = applyReview(base, 4, now);
    expect(result.dueDate.getTime()).toBe(addDays(now, 15).getTime());
    expect(result.leechCount).toBe(0);
  });

  it('inkrementuje leechCount po nieudanej powtórce', () => {
    const result = applyReview({ ...base, leechCount: 2 }, 1, new Date());
    expect(result.leechCount).toBe(3);
    expect(result.interval).toBe(1);
  });
});

describe('previewInterval i formatInterval', () => {
  it('podpowiada odstęp bez zmiany stanu fiszki', () => {
    const card = { interval: 10, repetitions: 3, easeFactor: 2.5 };
    expect(previewInterval(card, 5)).toBe(25);
    expect(card.interval).toBe(10);
  });

  it('formatuje odstępy po polsku', () => {
    expect(formatInterval(0)).toBe('dziś');
    expect(formatInterval(1)).toBe('1 dzień');
    expect(formatInterval(3)).toBe('3 dni');
    expect(formatInterval(30)).toBe('1 miesiąc');
    expect(formatInterval(90)).toBe('3 miesiące');
    expect(formatInterval(365)).toBe('1 rok');
  });
});
