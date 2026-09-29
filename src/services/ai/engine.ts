import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  InitProgressReport,
  MLCEngineInterface,
} from '@mlc-ai/web-llm';

import { deviceMemoryGb, detectWebGPU, type WebGPUReport } from '@/lib/webgpu';
import {
  DEFAULT_MODEL_ID,
  detectMobile,
  isModelCompatible,
  loadCachedModelIds,
  loadPreferredModelId,
  markModelCached,
  recommendModel,
  savePreferredModelId,
  unmarkModelCached,
  type DeviceProfile,
} from '@/lib/models';
import { errorMessage } from '@/lib/utils';

import {
  GPU_EVENTS_CHANNEL,
  describeGpuEvent,
  isGpuEvent,
  isGpuFailure,
} from './gpu-events';
import { EngineRuntimeError } from './errors';

/**
 * Bibliotekę WebLLM (≈6 MB) ładujemy dynamicznie — dzięki temu panel, nauka
 * i edycja fiszek startują natychmiast, a kod modelu pobiera się dopiero przy
 * pierwszym uruchomieniu silnika. Importy typów są wymazywane w kompilacji.
 */
type WebLLMModule = typeof import('@mlc-ai/web-llm');

/* -------------------------------------------------------------------------- */
/*                                    Stan                                    */
/* -------------------------------------------------------------------------- */

export type EngineStatus =
  /** Nie sprawdzono jeszcze wsparcia WebGPU. */
  | 'unchecked'
  /** Trwa sprawdzanie WebGPU. */
  | 'checking'
  /** Brak WebGPU — generowanie niedostępne (reszta aplikacji działa). */
  | 'unsupported'
  /** WebGPU gotowe, model nie jest wczytany. */
  | 'unloaded'
  /** Pobieranie / kompilacja modelu. */
  | 'loading'
  /** Model gotowy do generowania. */
  | 'ready'
  /** Błąd inicjalizacji modelu. */
  | 'error';

export interface EngineState {
  status: EngineStatus;
  /** Model wybrany przez użytkownika (nie zawsze już wczytany). */
  modelId: string;
  /** Model faktycznie wczytany do pamięci GPU. */
  loadedModelId: string | null;
  /** Postęp wczytywania 0–1. */
  progress: number;
  /** Komunikat postępu z WebLLM (przetłumaczony na polski, gdy to możliwe). */
  progressText: string;
  error: string | null;
  webgpu: WebGPUReport;
  /** Czy wagi wybranego modelu są już w cache (praca offline). */
  cached: boolean;
  /** Czy trwa generowanie odpowiedzi. */
  busy: boolean;
  /** Możliwości urządzenia — sterują listą dostępnych modeli. */
  profile: DeviceProfile;
  /**
   * Ustawione, gdy zapamiętany model nie działałby na tym urządzeniu
   * i został automatycznie podmieniony na zgodny.
   */
  autoSwitchedFrom: string | null;
  /**
   * Ostatnie awarie GPU zgłoszone przez worker (utrata urządzenia, brak
   * pamięci) — najnowsza na końcu. Trafiają do raportu z generowania.
   */
  gpuEvents: string[];
}

/**
 * Opcje przekazywane do KAŻDEGO wczytania modelu.
 *
 * `sliding_window_size: -1` — Gemma 3 ma w swojej konfiguracji okno przesuwne
 * 512 tokenów, a wpis WebLLM ustawia jej okno kontekstu na 4096. WebLLM odrzuca
 * dwa dodatnie okna naraz (WindowSizeConfigurationError), więc model w ogóle się
 * nie wczytywał. Wyłączenie okna przesuwnego to dokładnie to, co WebLLM robi
 * sam w swoich wpisach dla innych takich modeli (np. Mistral 7B); dla modeli bez
 * okna przesuwnego nic się nie zmienia (u nich i tak jest -1).
 * Sprawdzenie całego katalogu: `npm run check:models`.
 */
export const CHAT_OPTIONS = { sliding_window_size: -1 } as const;

/** Ile ostatnich zdarzeń GPU trzymamy w stanie. */
const MAX_GPU_EVENTS = 4;

const INITIAL_STATE: EngineState = {
  status: 'unchecked',
  modelId: DEFAULT_MODEL_ID,
  loadedModelId: null,
  progress: 0,
  progressText: '',
  error: null,
  webgpu: { status: 'unknown' },
  cached: false,
  busy: false,
  profile: { supportsF16: undefined, isMobile: false, memoryGb: undefined },
  autoSwitchedFrom: null,
  gpuEvents: [],
};


export interface GenerateJsonOptions {
  messages: ChatCompletionMessageParam[];
  /** Gramatyka EBNF (xgrammar) wymuszająca dokładny format odpowiedzi. */
  grammar: string;
  maxTokens: number;
  temperature?: number;
}

export interface GenerateJsonResult {
  content: string;
  /** `length` — odpowiedź ucięta limitem tokenów. */
  finishReason: string | null;
}

/* -------------------------------------------------------------------------- */
/*                              Serwis silnika                                */
/* -------------------------------------------------------------------------- */

/**
 * Singleton zarządzający cyklem życia modelu WebLLM.
 * Udostępnia prosty store (`subscribe`/`getState`) zgodny z
 * `useSyncExternalStore`, więc React nie potrzebuje dodatkowej biblioteki stanu.
 */
class LLMEngineService {
  private state: EngineState = { ...INITIAL_STATE, modelId: readInitialModelId() };
  private listeners = new Set<() => void>();
  private worker: Worker | null = null;
  private engine: MLCEngineInterface | null = null;
  private loadPromise: Promise<void> | null = null;
  private library: WebLLMModule | null = null;
  private libraryPromise: Promise<WebLLMModule> | null = null;
  private gpuChannel: BroadcastChannel | null = null;

  /** Nasłuch zdarzeń GPU z workera (patrz llm.worker.ts). */
  private listenForGpuEvents(): void {
    if (this.gpuChannel !== null || typeof BroadcastChannel === 'undefined') return;
    this.gpuChannel = new BroadcastChannel(GPU_EVENTS_CHANNEL);
    this.gpuChannel.onmessage = (event: MessageEvent<unknown>): void => {
      if (!isGpuEvent(event.data) || !isGpuFailure(event.data)) return;
      const entry = `${new Date(event.data.at).toLocaleTimeString('pl-PL')} ${describeGpuEvent(event.data)}`;
      this.setState({ gpuEvents: [...this.state.gpuEvents, entry].slice(-MAX_GPU_EVENTS) });
    };
  }

  /** Ładuje (raz) bibliotekę WebLLM na żądanie. */
  private async loadLibrary(): Promise<WebLLMModule> {
    if (this.library !== null) return this.library;
    this.libraryPromise ??= import('@mlc-ai/web-llm');
    this.library = await this.libraryPromise;
    return this.library;
  }

  getState = (): EngineState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(patch: Partial<EngineState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Sprawdza WebGPU i obecność modelu w cache. Bezpieczne do wielokrotnego wywołania. */
  async initialize(): Promise<EngineState> {
    if (this.state.status !== 'unchecked') return this.state;

    this.setState({ status: 'checking', webgpu: { status: 'checking' } });
    const report = await detectWebGPU();

    if (report.status !== 'supported') {
      this.setState({ status: 'unsupported', webgpu: report });
      return this.state;
    }

    const profile: DeviceProfile = {
      supportsF16: report.supportsF16,
      isMobile: detectMobile(),
      memoryGb: deviceMemoryGb(),
    };

    /**
     * Zapamiętany model może nie pasować do tego urządzenia — np. wariant f16
     * na karcie bez `shader-f16` albo duży model na telefonie. Podmieniamy go
     * na zgodny, zamiast pozwolić użytkownikowi trafić na błąd kompilacji.
     */
    let modelId = this.state.modelId;
    let autoSwitchedFrom: string | null = null;
    if (!isModelCompatible(modelId, profile)) {
      autoSwitchedFrom = modelId;
      modelId = recommendModel(profile);
      savePreferredModelId(modelId);
    }

    this.setState({
      status: 'unloaded',
      webgpu: report,
      profile,
      modelId,
      autoSwitchedFrom,
      cached: await this.isModelCached(modelId),
    });
    return this.state;
  }

  /**
   * Czy wagi modelu są już na urządzeniu.
   * Dopóki biblioteka WebLLM nie jest w pamięci, opieramy się na lokalnym
   * znaczniku — nie warto pobierać 6 MB kodu tylko po to, by odpytać cache.
   */
  async isModelCached(modelId: string): Promise<boolean> {
    if (this.library === null) {
      return loadCachedModelIds().includes(modelId);
    }
    try {
      return await this.library.hasModelInCache(modelId);
    } catch {
      return false;
    }
  }

  /** Zmienia wybrany model; jeśli inny model był wczytany — zwalnia go. */
  async selectModel(modelId: string): Promise<void> {
    if (modelId === this.state.modelId) return;
    savePreferredModelId(modelId);
    const cached = await this.isModelCached(modelId);
    this.setState({ modelId, cached, error: null });
    if (this.state.loadedModelId !== null && this.state.loadedModelId !== modelId) {
      await this.unload();
    }
  }

  /**
   * Pobiera (przy pierwszym uruchomieniu) i inicjalizuje model.
   * Kolejne wywołania w trakcie wczytywania dołączają do tej samej operacji.
   */
  async load(modelId: string = this.state.modelId): Promise<void> {
    if (this.state.status === 'ready' && this.state.loadedModelId === modelId) return;
    if (this.loadPromise !== null) return this.loadPromise;

    const task = this.runLoad(modelId);
    this.loadPromise = task;
    try {
      await task;
    } finally {
      this.loadPromise = null;
    }
  }

  private async runLoad(modelId: string): Promise<void> {
    if (this.state.status === 'unchecked' || this.state.status === 'checking') {
      await this.initialize();
    }
    if (this.state.webgpu.status !== 'supported') {
      throw new Error(this.state.webgpu.reason ?? 'WebGPU nie jest dostępne w tej przeglądarce.');
    }

    this.setState({
      status: 'loading',
      modelId,
      progress: 0,
      progressText: 'Przygotowanie silnika…',
      error: null,
    });

    try {
      const webllm = await this.loadLibrary();
      const worker = this.ensureWorker();
      const initProgressCallback = (report: InitProgressReport): void => {
        this.setState({
          progress: clamp01(report.progress),
          progressText: translateProgress(report.text),
        });
      };

      /**
       * Zerwane połączenie w trakcie pobierania (częste na komórce) nie może
       * przekreślać całego wczytywania: WebLLM trzyma już pobrane części wag
       * w cache, więc kolejna próba po prostu kontynuuje od miejsca przerwania.
       */
      for (let attempt = 1; ; attempt += 1) {
        try {
          if (this.engine === null) {
            this.engine = await webllm.CreateWebWorkerMLCEngine(
              worker,
              modelId,
              { initProgressCallback },
              CHAT_OPTIONS,
            );
          } else {
            this.engine.setInitProgressCallback(initProgressCallback);
            await this.engine.reload(modelId, CHAT_OPTIONS);
          }
          break;
        } catch (error) {
          if (attempt >= DOWNLOAD_ATTEMPTS || !isNetworkError(errorMessage(error))) throw error;
          this.setState({ progressText: `Połączenie przerwane — wznawiam pobieranie (próba ${attempt + 1}/${DOWNLOAD_ATTEMPTS})…` });
          await delay(DOWNLOAD_RETRY_DELAY_MS * attempt);
        }
      }

      markModelCached(modelId);
      this.setState({
        status: 'ready',
        loadedModelId: modelId,
        progress: 1,
        progressText: 'Model gotowy',
        cached: true,
        error: null,
      });
    } catch (error) {
      const message = explainLoadError(errorMessage(error), this.state.profile);
      this.setState({
        status: 'error',
        error: message,
        progressText: '',
        loadedModelId: null,
      });
      throw new Error(message);
    }
  }

  private ensureWorker(): Worker {
    if (this.worker === null) {
      this.listenForGpuEvents();
      // Klasyczny worker (format IIFE z konfiguracji Vite) — patrz vite.config.ts.
      this.worker = new Worker(new URL('../../workers/llm.worker.ts', import.meta.url), {
        name: 'cognitivedeck-llm',
      });
    }
    return this.worker;
  }

  /**
   * Odzyskuje model po jego utracie w workerze (ModelNotLoadedError).
   *
   * Nie można tu użyć `load()`: ten wychodzi od razu, gdy stan mówi „gotowy”,
   * a stan nie wie, że system zwolnił pamięć workera — więc „ponowne
   * wczytanie” było pustym wywołaniem i każde kolejne zapytanie trafiało
   * w ten sam pusty worker.
   *
   * Najpierw próbujemy udokumentowanej drogi WebLLM (`reload()` po utracie
   * urządzenia). Gdy worker jest uszkodzony na tyle, że i to zawodzi,
   * tworzymy od zera nowy worker i nowy silnik.
   */
  async recover(options: { hard?: boolean } = {}): Promise<void> {
    const modelId = this.state.loadedModelId ?? this.state.modelId;

    this.setState({
      status: 'loading',
      loadedModelId: null,
      progress: 0,
      progressText: 'Ponowne wczytywanie modelu…',
      error: null,
    });

    const initProgressCallback = (report: InitProgressReport): void => {
      this.setState({
        progress: clamp01(report.progress),
        progressText: translateProgress(report.text),
      });
    };

    try {
      const webllm = await this.loadLibrary();

      let reloaded = false;
      // Przy twardym restarcie nie ufamy staremu workerowi w ogóle.
      if (this.engine !== null && options.hard !== true) {
        try {
          this.engine.setInitProgressCallback(initProgressCallback);
          await this.engine.reload(modelId, CHAT_OPTIONS);
          reloaded = true;
        } catch {
          // Worker nie odpowiada poprawnie — przechodzimy do twardego restartu.
        }
      }

      if (!reloaded) {
        await this.disposeWorker();
        this.engine = await webllm.CreateWebWorkerMLCEngine(
          this.ensureWorker(),
          modelId,
          { initProgressCallback },
          CHAT_OPTIONS,
        );
      }

      this.setState({
        status: 'ready',
        loadedModelId: modelId,
        progress: 1,
        progressText: 'Model gotowy',
        error: null,
      });
    } catch (error) {
      const message = explainLoadError(errorMessage(error), this.state.profile);
      this.setState({ status: 'error', error: message, loadedModelId: null, progressText: '' });
      throw new Error(message);
    }
  }

  /**
   * Zwalnia stary worker ZANIM powstanie nowy. Samo `terminate()` oddaje pamięć
   * GPU asynchronicznie, więc nowy model wczytywał się, gdy stary jeszcze ją
   * zajmował — na telefonie podwójne zużycie pamięci kończyło się kolejną
   * awarią i „odzyskiwanie” samo wywoływało to, przed czym miało chronić.
   */
  private async disposeWorker(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    if (engine !== null) {
      // Po utracie urządzenia unload() potrafi nie odpowiedzieć — nie czekamy w nieskończoność.
      await Promise.race([engine.unload().catch(() => undefined), delay(WORKER_UNLOAD_TIMEOUT_MS)]);
    }
    this.worker?.terminate();
    this.worker = null;
    // Chwila dla przeglądarki na faktyczne zwolnienie pamięci zakończonego workera.
    await delay(WORKER_RELEASE_PAUSE_MS);
  }

  /** Zwalnia pamięć GPU (model zostaje w cache dysku). */
  async unload(): Promise<void> {
    if (this.engine !== null) {
      try {
        await this.engine.unload();
      } catch {
        // Silnik mógł już utracić urządzenie — stan czyścimy i tak.
      }
    }
    this.setState({
      status: this.state.webgpu.status === 'supported' ? 'unloaded' : this.state.status,
      loadedModelId: null,
      progress: 0,
      progressText: '',
      busy: false,
    });
  }

  /** Usuwa wagi modelu z cache przeglądarki (zwalnia miejsce na dysku). */
  async removeFromCache(modelId: string): Promise<void> {
    if (this.state.loadedModelId === modelId) {
      await this.unload();
    }
    const webllm = await this.loadLibrary();
    await webllm.deleteModelAllInfoInCache(modelId);
    unmarkModelCached(modelId);
    if (modelId === this.state.modelId) {
      this.setState({ cached: false });
    }
  }

  /** Przerywa trwające generowanie (przycisk „Zatrzymaj”). */
  interrupt(): void {
    this.engine?.interruptGenerate();
  }

  /**
   * Jedno zapytanie do modelu z wymuszoną gramatyką.
   * Zwraca surowy tekst odpowiedzi — walidację wykonuje warstwa wyżej.
   */
  async generateJson(options: GenerateJsonOptions): Promise<GenerateJsonResult> {
    if (this.engine === null || this.state.status !== 'ready') {
      throw new Error('Model nie jest wczytany. Uruchom go w panelu, aby generować fiszki.');
    }

    this.setState({ busy: true });
    try {
      let completion: ChatCompletion;
      try {
        completion = await this.engine.chat.completions.create({
          messages: options.messages,
          response_format: { type: 'grammar', grammar: options.grammar },
          temperature: options.temperature ?? 0.3,
          max_tokens: options.maxTokens,
          stream: false,
        });
      } catch (error) {
        throw new EngineRuntimeError(errorMessage(error));
      }

      const choice = completion.choices[0];
      const content = choice?.message.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new Error('Model zwrócił pustą odpowiedź.');
      }
      return { content, finishReason: choice?.finish_reason ?? null };
    } finally {
      this.setState({ busy: false });
    }
  }

  /** Statystyki dekodowania (tokeny/s) — pokazywane po generowaniu. */
  async runtimeStats(): Promise<string | null> {
    if (this.engine === null) return null;
    try {
      return await this.engine.runtimeStatsText();
    } catch {
      return null;
    }
  }
}

/**
 * Surowe błędy WebGPU/WebLLM są nieczytelne ("Device lost", "out of memory",
 * "buffer size exceeds limit"). Dokładamy wskazówkę, co z tym zrobić —
 * na telefonie prawie zawsze chodzi o limit pamięci karty przeglądarki.
 */
export function explainLoadError(message: string, profile: DeviceProfile): string {
  const lower = message.toLowerCase();

  if (lower.includes('shader-f16') || lower.includes('f16')) {
    return `${message}\n\nTa karta graficzna nie obsługuje obliczeń f16. Wybierz model z dopiskiem „(f32)”.`;
  }

  if (
    lower.includes('out of memory') ||
    lower.includes('oom') ||
    lower.includes('device lost') ||
    lower.includes('exceeds') ||
    lower.includes('allocation')
  ) {
    return profile.isMobile
      ? `${message}\n\nNa telefonie zabrakło pamięci dla modelu. Wybierz Llama 3.2 1B (albo eksperymentalną Gemma 3 1B), zamknij inne karty i spróbuj ponownie. Część telefonów — zwłaszcza iPhone — ma limit pamięci zbyt niski nawet dla najmniejszych modeli; wtedy fiszki wygeneruj na komputerze i przenieś je kopią zapasową.`
      : `${message}\n\nZabrakło pamięci GPU. Wybierz mniejszy model albo zamknij inne aplikacje korzystające z karty graficznej.`;
  }

  if (isNetworkError(message)) {
    return `${message}\n\nNie udało się pobrać wag modelu. Sprawdź połączenie z internetem — pierwsze uruchomienie wymaga pobrania pliku modelu.`;
  }

  return message;
}

function readInitialModelId(): string {
  return typeof window === 'undefined' ? DEFAULT_MODEL_ID : loadPreferredModelId();
}

const WORKER_UNLOAD_TIMEOUT_MS = 3000;
const DOWNLOAD_ATTEMPTS = 5;
const DOWNLOAD_RETRY_DELAY_MS = 1500;

/** Chrome: „Failed to fetch”, Firefox: „NetworkError…”, Safari: „Load failed”. */
export function isNetworkError(message: string): boolean {
  return /failed to fetch|networkerror|network error|load failed|failed to load|err_network|connection/i.test(
    message,
  );
}

const WORKER_RELEASE_PAUSE_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** WebLLM raportuje postęp po angielsku — tłumaczymy najczęstsze komunikaty. */
export function translateProgress(text: string): string {
  const fetching = /Fetching param cache\[(\d+)\/(\d+)\]:\s*([\d.]+\s*\wB)/i.exec(text);
  if (fetching !== null) {
    return `Pobieranie wag modelu ${fetching[1]}/${fetching[2]} (${fetching[3]})`;
  }
  const loading = /Loading model from cache\[(\d+)\/(\d+)\]/i.exec(text);
  if (loading !== null) {
    return `Wczytywanie modelu z pamięci urządzenia ${loading[1]}/${loading[2]}`;
  }
  if (/Loading GPU shader modules/i.test(text)) return 'Kompilacja shaderów GPU…';
  if (/Finish loading on WebGPU/i.test(text)) return 'Model gotowy';
  if (/Start to fetch params/i.test(text)) return 'Rozpoczynam pobieranie wag modelu…';
  return text;
}

export const llmEngine = new LLMEngineService();
