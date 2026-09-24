/**
 * Błąd zgłoszony przez sam silnik w trakcie generowania (a nie przez walidację
 * odpowiedzi). Na telefonie to niemal zawsze utrata urządzenia GPU — pod
 * różnymi komunikatami: „map async was not successful”, „already been
 * disposed”, ModelNotLoadedError — więc wywołujący traktuje go jako sygnał
 * do odtworzenia silnika, zamiast dopasowywać konkretne treści.
 */
export class EngineRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineRuntimeError';
  }
}

/**
 * Silnik odtwarzano już maksymalną liczbę razy i GPU wciąż odmawia pracy —
 * dalsze próby tylko zużywałyby baterię. Przerywa generowanie od razu.
 */
export class GpuExhaustedError extends Error {
  constructor(lastError: string, reloads: number) {
    super(
      `Urządzenie GPU odmawia pracy — silnik odtworzono ${reloads} razy i za każdym razem ` +
        `system go zatrzymał. Ostatni błąd: ${lastError}`,
    );
    this.name = 'GpuExhaustedError';
  }
}
