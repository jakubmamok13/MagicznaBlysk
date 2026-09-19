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

/* -------------------------------------------------------------------------- */
/*            Asynchroniczna iteracja po ReadableStream (Safari)              */
/* -------------------------------------------------------------------------- */

interface StreamAsyncIterator<T> extends AsyncIterableIterator<T> {
  next: () => Promise<IteratorResult<T, undefined>>;
}

type ReadableStreamWithValues = ReadableStream<unknown> & {
  values?: (options?: { preventCancel?: boolean }) => StreamAsyncIterator<unknown>;
  [Symbol.asyncIterator]?: () => StreamAsyncIterator<unknown>;
};

/**
 * `for await (const chunk of readableStream)` nie działa w Safari — WebKit do
 * dziś nie wystawia `ReadableStream.prototype[Symbol.asyncIterator]`.
 *
 * pdf.js opiera na tym `getTextContent()`, więc bez tego polyfilla odczyt
 * tekstu z PDF-a kończy się na iPhonie komunikatem
 * „undefined is not a function”, mimo najnowszego systemu.
 *
 * Implementacja zgodna ze specyfikacją WHATWG (sekcja „Asynchronous iteration”).
 */
export function installReadableStreamAsyncIterator(): void {
  if (typeof ReadableStream === 'undefined') return;

  const prototype = ReadableStream.prototype as ReadableStreamWithValues;
  if (typeof prototype[Symbol.asyncIterator] === 'function') return;

  function values(
    this: ReadableStream<unknown>,
    options?: { preventCancel?: boolean },
  ): StreamAsyncIterator<unknown> {
    const reader = this.getReader();
    const preventCancel = options?.preventCancel === true;

    const iterator: StreamAsyncIterator<unknown> = {
      async next(): Promise<IteratorResult<unknown, undefined>> {
        try {
          const result = await reader.read();
          if (result.done === true) {
            reader.releaseLock();
            return { done: true, value: undefined };
          }
          return { done: false, value: result.value };
        } catch (error) {
          reader.releaseLock();
          throw error;
        }
      },
      async return(value?: unknown): Promise<IteratorResult<unknown, undefined>> {
        if (!preventCancel) {
          const cancelled = reader.cancel(value);
          reader.releaseLock();
          await cancelled;
        } else {
          reader.releaseLock();
        }
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator](): StreamAsyncIterator<unknown> {
        return iterator;
      },
    };

    return iterator;
  }

  prototype.values = values;
  prototype[Symbol.asyncIterator] = function asyncIterator(
    this: ReadableStream<unknown>,
  ): StreamAsyncIterator<unknown> {
    return values.call(this);
  };
}

/** Instaluje komplet polyfilli wymaganych przez aplikację. */
export function installPolyfills(): void {
  installPromiseWithResolvers();
  installReadableStreamAsyncIterator();
}

/** Czy przeglądarka miała natywne `Promise.withResolvers` przed polyfillem. */
export function hasNativePromiseWithResolvers(): boolean {
  return typeof (Promise as PromiseConstructorWithResolvers).withResolvers === 'function';
}
