import { describe, expect, it } from 'vitest';
import {
  compatibleModels,
  findModel,
  isModelCompatible,
  MODEL_OPTIONS,
  recommendModel,
  type DeviceProfile,
} from './models';

const DESKTOP_F16: DeviceProfile = { supportsF16: true, isMobile: false, memoryGb: 16 };
const DESKTOP_NO_F16: DeviceProfile = { supportsF16: false, isMobile: false, memoryGb: 8 };
const PHONE_F16: DeviceProfile = { supportsF16: true, isMobile: true, memoryGb: 4 };
const PHONE_NO_F16: DeviceProfile = { supportsF16: false, isMobile: true, memoryGb: 3 };

describe('katalog modeli', () => {
  it('zawiera warianty f32 dla kart bez shader-f16', () => {
    expect(MODEL_OPTIONS.some((model) => model.precision === 'f32')).toBe(true);
  });

  it('każdy model f32 ma odpowiednik dla telefonu', () => {
    const mobileF32 = MODEL_OPTIONS.filter((m) => m.precision === 'f32' && m.mobileFriendly === true);
    expect(mobileF32.length).toBeGreaterThan(0);
  });
});

describe('compatibleModels', () => {
  it('bez shader-f16 nie proponuje modeli f16', () => {
    const list = compatibleModels(DESKTOP_NO_F16);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((model) => model.precision === 'f32')).toBe(true);
  });

  it('na telefonie pokazuje wyłącznie modele mieszczące się w pamięci', () => {
    expect(compatibleModels(PHONE_F16).every((model) => model.mobileFriendly === true)).toBe(true);
  });

  it('na telefonie bez f16 zostają tylko małe modele f32', () => {
    const list = compatibleModels(PHONE_NO_F16);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((m) => m.precision === 'f32' && m.mobileFriendly === true)).toBe(true);
  });

  it('na komputerze z f16 udostępnia pełny katalog', () => {
    expect(compatibleModels(DESKTOP_F16)).toHaveLength(MODEL_OPTIONS.length);
  });
});

describe('recommendModel', () => {
  it('na komputerze wybiera model oznaczony jako zalecany', () => {
    expect(findModel(recommendModel(DESKTOP_F16))?.recommended).toBe(true);
  });

  it('na telefonie wybiera najmniejszy dostępny model', () => {
    const chosen = findModel(recommendModel(PHONE_F16));
    const smallest = [...compatibleModels(PHONE_F16)].sort((a, b) => a.vramMb - b.vramMb)[0];
    expect(chosen?.id).toBe(smallest?.id);
  });

  it('zawsze zwraca model zgodny z urządzeniem', () => {
    for (const profile of [DESKTOP_F16, DESKTOP_NO_F16, PHONE_F16, PHONE_NO_F16]) {
      expect(isModelCompatible(recommendModel(profile), profile)).toBe(true);
    }
  });

  it('model f16 jest odrzucany na karcie bez f16', () => {
    expect(isModelCompatible('Llama-3.2-3B-Instruct-q4f16_1-MLC', DESKTOP_NO_F16)).toBe(false);
    expect(isModelCompatible('Llama-3.2-3B-Instruct-q4f32_1-MLC', DESKTOP_NO_F16)).toBe(true);
  });
});
