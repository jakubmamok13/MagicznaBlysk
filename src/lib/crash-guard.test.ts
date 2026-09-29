import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearCrashes,
  consumeCrashReport,
  crashCount,
  markGenerationFinished,
  markGenerationStarted,
} from './crash-guard';

const MODEL = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';

function fakeBrowser(): { fire: (event: string) => void } {
  const store = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  vi.stubGlobal('window', {
    addEventListener: (name: string, fn: () => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)?.add(fn);
    },
    removeEventListener: (name: string, fn: () => void) => listeners.get(name)?.delete(fn),
  });
  return { fire: (name) => listeners.get(name)?.forEach((fn) => fn()) };
}

describe('crash-guard', () => {
  let browser: ReturnType<typeof fakeBrowser>;
  beforeEach(() => {
    vi.unstubAllGlobals();
    browser = fakeBrowser();
  });

  it('strona ubita w trakcie generowania: przy następnym starcie jest raport i licznik', () => {
    markGenerationStarted(MODEL);
    // …tu iOS zabija kartę — nic więcej się nie wykonuje.

    const report = consumeCrashReport();
    expect(report?.modelId).toBe(MODEL);
    expect(crashCount(MODEL)).toBe(1);
    // Raport odczytuje się raz — kolejny start nie pokazuje go ponownie.
    expect(consumeCrashReport()).toBeNull();
  });

  it('normalne zakończenie generowania nie jest awarią', () => {
    markGenerationStarted(MODEL);
    markGenerationFinished();
    expect(consumeCrashReport()).toBeNull();
    expect(crashCount(MODEL)).toBe(0);
  });

  it('zamknięcie karty przez użytkownika (pagehide) nie jest awarią', () => {
    markGenerationStarted(MODEL);
    browser.fire('pagehide');
    expect(consumeCrashReport()).toBeNull();
  });

  it('awarie sumują się, a udane generowanie zeruje licznik modelu', () => {
    markGenerationStarted(MODEL);
    consumeCrashReport();
    markGenerationStarted(MODEL);
    consumeCrashReport();
    expect(crashCount(MODEL)).toBe(2);
    expect(crashCount('inny-model')).toBe(0);

    clearCrashes(MODEL);
    expect(crashCount(MODEL)).toBe(0);
  });

  it('bez localStorage (tryb prywatny) nic się nie wywraca', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(() => markGenerationStarted(MODEL)).not.toThrow();
    expect(consumeCrashReport()).toBeNull();
    expect(crashCount(MODEL)).toBe(0);
  });
});
