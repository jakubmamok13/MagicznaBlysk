import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Testy prawdziwej klasy silnika — mockujemy wyłącznie WebLLM, Workera
 * i wykrywanie WebGPU. Wcześniejszy test samoregeneracji mockował samo
 * `load()` i przez to przepuścił błąd: `load()` przy stanie „gotowy” wychodzi
 * od razu, więc ponowne wczytanie po ubiciu workera było pustym wywołaniem.
 */

const reload = vi.fn<(modelId: string) => Promise<void>>();
const setInitProgressCallback = vi.fn<(cb: unknown) => void>();
const createEngine = vi.fn<(...args: unknown[]) => void>();
const terminated: number[] = [];
const createCompletion = vi.fn<() => Promise<unknown>>();
const createCompletionArgs: unknown[] = [];
const unloadSpy = vi.fn<() => Promise<void>>();

const fakeEngine = {
  reload: (modelId: string) => reload(modelId),
  setInitProgressCallback: (cb: unknown) => setInitProgressCallback(cb),
  unload: () => unloadSpy(),
  interruptGenerate: () => undefined,
  runtimeStatsText: () => Promise.resolve(''),
  chat: {
    completions: {
      create: (args: unknown) => {
        createCompletionArgs.push(args);
        return createCompletion();
      },
    },
  },
};

vi.mock('@mlc-ai/web-llm', () => ({
  CreateWebWorkerMLCEngine: (...args: unknown[]) => {
    createEngine(...args);
    return Promise.resolve(fakeEngine);
  },
  hasModelInCache: () => Promise.resolve(true),
  deleteModelAllInfoInCache: () => Promise.resolve(),
}));

vi.mock('@/lib/webgpu', () => ({
  detectWebGPU: () => Promise.resolve({ status: 'supported', supportsF16: true }),
  deviceMemoryGb: () => 16,
}));

let workerCount = 0;
class FakeWorker {
  readonly id = ++workerCount;
  terminate(): void {
    terminated.push(this.id);
  }
}
vi.stubGlobal('Worker', FakeWorker);

/**
 * Przesuwa sztuczny zegar, oddając między krokami prawdziwą turę pętli zdarzeń
 * (dynamiczny import biblioteki kończy się poza sztucznymi timerami).
 */
async function settleWithFakeTimers(task: Promise<unknown>): Promise<void> {
  let settled = false;
  task.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let step = 0; step < 100 && !settled; step += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(500);
  }
  await task;
}

async function freshEngine(): Promise<typeof import('./engine')['llmEngine']> {
  vi.resetModules();
  return (await import('./engine')).llmEngine;
}

describe('llmEngine.recover', () => {
  beforeEach(() => {
    reload.mockReset();
    reload.mockResolvedValue();
    setInitProgressCallback.mockReset();
    createEngine.mockReset();
    unloadSpy.mockReset();
    unloadSpy.mockResolvedValue();
    terminated.length = 0;
    workerCount = 0;
  });

  it('load() przy stanie „gotowy” nie przeładowuje modelu (dlatego potrzebne jest recover)', async () => {
    const engine = await freshEngine();
    await engine.load();
    expect(engine.getState().status).toBe('ready');

    await engine.load();
    // To jest dokładnie pułapka, w którą wpadła poprzednia wersja samoregeneracji.
    expect(reload).not.toHaveBeenCalled();
    expect(createEngine).toHaveBeenCalledTimes(1);
  });

  it('recover() faktycznie przeładowuje model, mimo stanu „gotowy”', async () => {
    const engine = await freshEngine();
    await engine.load();
    const modelId = engine.getState().loadedModelId;

    await engine.recover();

    expect(reload).toHaveBeenCalledWith(modelId);
    expect(engine.getState().status).toBe('ready');
    expect(engine.getState().loadedModelId).toBe(modelId);
  });

  it('gdy reload() zawodzi, tworzy od zera nowy worker i silnik', async () => {
    const engine = await freshEngine();
    await engine.load();
    reload.mockRejectedValue(new Error('worker nie odpowiada'));

    await engine.recover();

    expect(terminated).toContain(1);
    expect(createEngine).toHaveBeenCalledTimes(2);
    expect(engine.getState().status).toBe('ready');
  });

  it('twardy restart pomija reload() i zawsze tworzy nowy worker', async () => {
    const engine = await freshEngine();
    await engine.load();

    await engine.recover({ hard: true });

    // Po „disposed” stan workera jest skażony — nie próbujemy go ratować.
    expect(reload).not.toHaveBeenCalled();
    expect(terminated).toContain(1);
    expect(createEngine).toHaveBeenCalledTimes(2);
    expect(engine.getState().status).toBe('ready');
  });

  it('w trakcie odzyskiwania stan nie udaje, że model jest gotowy', async () => {
    const engine = await freshEngine();
    await engine.load();

    const seen: string[] = [];
    const unsubscribe = engine.subscribe(() => seen.push(engine.getState().status));
    await engine.recover();
    unsubscribe();

    expect(seen[0]).toBe('loading');
    expect(seen.at(-1)).toBe('ready');
  });
});

describe('llmEngine — błędy w trakcie generowania', () => {
  beforeEach(() => {
    createCompletion.mockReset();
    createEngine.mockReset();
    unloadSpy.mockReset();
    unloadSpy.mockResolvedValue();
    terminated.length = 0;
    workerCount = 0;
  });

  it('błąd silnika jest opakowany w EngineRuntimeError (sygnał do odtworzenia)', async () => {
    const engine = await freshEngine();
    const { EngineRuntimeError } = await import('./errors');
    await engine.load();
    createCompletion.mockRejectedValue(new Error('OperationError: map async was not successful'));

    const failure = await engine
      .generateJson({ messages: [], grammar: 'root ::= "{}"', maxTokens: 10 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EngineRuntimeError);
    expect((failure as Error).message).toMatch(/map async/);
    expect(engine.getState().busy).toBe(false);
  });

  it('pusta odpowiedź NIE jest błędem silnika (nie odtwarzamy go bez potrzeby)', async () => {
    const engine = await freshEngine();
    const { EngineRuntimeError } = await import('./errors');
    await engine.load();
    createCompletion.mockResolvedValue({ choices: [{ message: { content: '' } }] });

    const failure = await engine
      .generateJson({ messages: [], grammar: 'root ::= "{}"', maxTokens: 10 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(EngineRuntimeError);
  });

  it('wysyła gramatykę EBNF i zwraca finish_reason (wykrywanie uciętych odpowiedzi)', async () => {
    const engine = await freshEngine();
    await engine.load();
    createCompletion.mockResolvedValue({ choices: [{ message: { content: '{"cards":[' }, finish_reason: 'length' }] });

    const result = await engine.generateJson({ messages: [], grammar: 'root ::= "x"', maxTokens: 10 });

    expect(result).toEqual({ content: '{"cards":[', finishReason: 'length' });
    expect(createCompletionArgs.at(-1)).toMatchObject({
      response_format: { type: 'grammar', grammar: 'root ::= "x"' },
      max_tokens: 10,
    });
  });

  it('odtworzenie zwalnia stary model PRZED wczytaniem nowego (bez podwójnej pamięci)', async () => {
    const engine = await freshEngine();
    await engine.load();
    const order: string[] = [];
    unloadSpy.mockImplementation(() => {
      order.push('unload');
      return Promise.resolve();
    });
    createEngine.mockImplementation(() => order.push('create'));
    const terminatedBefore = terminated.length;

    await engine.recover({ hard: true });

    expect(order).toEqual(['unload', 'create']);
    expect(terminated.length).toBe(terminatedBefore + 1);
  });

  it('odtworzenie nie zawiesza się, gdy unload() starego silnika nie odpowiada', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const engine = await freshEngine();
      await engine.load();
      unloadSpy.mockImplementation(() => new Promise<void>(() => undefined));
      const recovering = engine.recover({ hard: true });
      await settleWithFakeTimers(recovering);
      expect(engine.getState().status).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('zerwane pobieranie wag jest wznawiane automatycznie', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const engine = await freshEngine();
      let calls = 0;
      createEngine.mockImplementation(() => {
        calls += 1;
        if (calls < 3) throw new TypeError('Load failed');
      });
      const loading = engine.load();
      await settleWithFakeTimers(loading);
      expect(calls).toBe(3);
      expect(engine.getState().status).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('zbiera zgłoszenia utraty GPU z workera, pomijając własne zwolnienia', async () => {
    const engine = await freshEngine();
    const { GPU_EVENTS_CHANNEL } = await import('./gpu-events');
    await engine.load();

    const sender = new BroadcastChannel(GPU_EVENTS_CHANNEL);
    sender.postMessage({ kind: 'lost', reason: 'destroyed', message: '', at: Date.now() });
    sender.postMessage({ kind: 'lost', reason: 'unknown', message: 'GPU process was killed', at: Date.now() });
    sender.postMessage({ kind: 'error', reason: 'GPUOutOfMemoryError', message: 'Out of memory', at: Date.now() });
    sender.postMessage('śmieci');
    await vi.waitFor(() => {
      expect(engine.getState().gpuEvents).toHaveLength(2);
    });
    sender.close();

    const [lost, oom] = engine.getState().gpuEvents;
    expect(lost).toMatch(/utrata urządzenia \(unknown\): GPU process was killed/);
    expect(oom).toMatch(/GPUOutOfMemoryError: Out of memory/);
  });
});
