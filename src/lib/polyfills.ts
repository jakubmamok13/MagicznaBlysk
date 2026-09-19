/**
 * Drobne uzupełnienia API dla starszych przeglądarek.
 *
 * `Promise.withResolvers()` to ES2024 — w Safari pojawiło się dopiero w 17.4.
 * pdf.js używa go w kilkudziesięciu miejscach (także w swoim workerze), więc
 * na starszym iPhonie odczyt PDF-a kończył się komunikatem
 * „undefined is not a function”. Polyfill jest zgodny ze specyfikacją i
 * wykonuje się tylko wtedy, gdy natywnej implementacji brak.
 */

interface PromiseWithResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

type PromiseConstructorWithResolvers = PromiseConstructor & {
  withResolvers?: <T>() => PromiseWithResolvers<T>;
};

export function installPromiseWithResolvers(): void {
  const target = Promise as PromiseConstructorWithResolvers;
  if (typeof target.withResolvers === 'function') return;

  target.withResolvers = function withResolvers<T>(): PromiseWithResolvers<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

/** Czy przeglądarka miała natywne `Promise.withResolvers` przed polyfillem. */
export function hasNativePromiseWithResolvers(): boolean {
  return typeof (Promise as PromiseConstructorWithResolvers).withResolvers === 'function';
}
