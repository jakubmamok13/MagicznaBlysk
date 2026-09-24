import type {
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
}

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
};

export interface GenerateJsonOptions {
  messages: ChatCompletionMessageParam[];
  /** Schemat JSON (string) wymuszany gramatyką dekodera. */
  schema: string;
  maxTokens?: number;
  temperature?: number;
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

      if (this.engine === null) {
        this.engine = await webllm.CreateWebWorkerMLCEngine(worker, modelId, {
          initProgressCallback,
        });
      } else {
        this.engine.setInitProgressCallback(initProgressCallback);
        await this.engine.reload(modelId);
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
  async recover(): Promise<void> {
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
      if (this.engine !== null) {
        try {
          this.engine.setInitProgressCallback(initProgressCallback);
          await this.engine.reload(modelId);
          reloaded = true;
        } catch {
          // Worker nie odpowiada poprawnie — przechodzimy do twardego restartu.
        }
      }

      if (!reloaded) {
        this.worker?.terminate();
        this.worker = null;
        this.engine = null;
        this.engine = await webllm.CreateWebWorkerMLCEngine(this.ensureWorker(), modelId, {
          initProgressCallback,
        });
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
   * Jedno zapytanie do modelu z wymuszonym schematem JSON.
   * Zwraca surowy tekst odpowiedzi — walidację wykonuje warstwa wyżej.
   */
  async generateJson(options: GenerateJsonOptions): Promise<string> {
    if (this.engine === null || this.state.status !== 'ready') {
      throw new Error('Model nie jest wczytany. Uruchom go w panelu, aby generować fiszki.');
    }

    this.setState({ busy: true });
    try {
      const completion = await this.engine.chat.completions.create({
        messages: options.messages,
        response_format: { type: 'json_object', schema: options.schema },
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens ?? 1800,
        stream: false,
      });

      const content = completion.choices[0]?.message.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new Error('Model zwrócił pustą odpowiedź.');
      }
      return content;
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
      ? `${message}\n\nNa telefonie zabrakło pamięci dla modelu. Wybierz mniejszy model (0.5B), zamknij inne karty i spróbuj ponownie. Część telefonów — zwłaszcza iPhone — ma limit pamięci zbyt niski nawet dla najmniejszych modeli; wtedy fiszki wygeneruj na komputerze i przenieś je kopią zapasową.`
      : `${message}\n\nZabrakło pamięci GPU. Wybierz mniejszy model albo zamknij inne aplikacje korzystające z karty graficznej.`;
  }

  if (lower.includes('fetch') || lower.includes('network') || lower.includes('failed to load')) {
    return `${message}\n\nNie udało się pobrać wag modelu. Sprawdź połączenie z internetem — pierwsze uruchomienie wymaga pobrania pliku modelu.`;
  }

  return message;
}

function readInitialModelId(): string {
  return typeof window === 'undefined' ? DEFAULT_MODEL_ID : loadPreferredModelId();
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
