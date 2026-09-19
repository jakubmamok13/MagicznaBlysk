/** Katalog modeli dostępnych lokalnie przez WebLLM. */

export interface ModelOption {
  /** Identyfikator modelu w `prebuiltAppConfig` WebLLM. */
  id: string;
  label: string;
  /** Przybliżony rozmiar pobierania. */
  downloadSize: string;
  /** Wymagana pamięć VRAM podawana przez WebLLM. */
  vramMb: number;
  description: string;
  /** Rekomendowany domyślnie (najlepszy stosunek jakości do rozmiaru). */
  recommended?: boolean;
}

export const MODEL_OPTIONS: readonly ModelOption[] = [
  {
    id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    label: 'Llama 3.2 3B Instruct',
    downloadSize: '~1,8 GB',
    vramMb: 2264,
    description:
      'Najlepsza jakość kompendium i fiszek. Zalecana na komputerze z min. 8 GB RAM.',
    recommended: true,
  },
  {
    id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    label: 'Qwen 2.5 1.5B Instruct',
    downloadSize: '~1,1 GB',
    vramMb: 1629,
    description: 'Szybki kompromis — dobra praca z językiem polskim i strukturą JSON.',
  },
  {
    id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    label: 'Llama 3.2 1B Instruct',
    downloadSize: '~0,7 GB',
    vramMb: 879,
    description: 'Najlżejszy wariant na słabsze urządzenia i telefony z WebGPU.',
  },
  {
    id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC',
    label: 'Qwen 2.5 3B Instruct',
    downloadSize: '~1,9 GB',
    vramMb: 2504,
    description: 'Mocny model o dużej precyzji cytowania źródeł.',
  },
] as const;

export const DEFAULT_MODEL_ID = 'Llama-3.2-3B-Instruct-q4f16_1-MLC';

const STORAGE_KEY = 'cognitivedeck:model-id';

export function findModel(modelId: string): ModelOption | undefined {
  return MODEL_OPTIONS.find((model) => model.id === modelId);
}

export function modelLabel(modelId: string): string {
  return findModel(modelId)?.label ?? modelId;
}

/** Zapamiętany wybór modelu (localStorage może być zablokowany — czytamy defensywnie). */
export function loadPreferredModelId(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null && findModel(stored) !== undefined) return stored;
  } catch {
    // Prywatny tryb przeglądania — zostajemy przy wartości domyślnej.
  }
  return DEFAULT_MODEL_ID;
}

export function savePreferredModelId(modelId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, modelId);
  } catch {
    // Brak dostępu do localStorage nie może przerwać działania aplikacji.
  }
}

/* -------------------------------------------------------------------------- */
/*                  Znacznik modeli pobranych na to urządzenie                */
/* -------------------------------------------------------------------------- */

const CACHE_KEY = 'cognitivedeck:cached-models';

/**
 * Lista modeli, które udało się już wczytać na tym urządzeniu.
 * Pozwala pokazać status „dostępny offline” bez ładowania całej biblioteki
 * WebLLM (≈6 MB) przy starcie aplikacji — dokładny stan cache weryfikujemy
 * dopiero wtedy, gdy biblioteka i tak jest w pamięci.
 */
export function loadCachedModelIds(): string[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function markModelCached(modelId: string): void {
  const ids = new Set(loadCachedModelIds());
  ids.add(modelId);
  persistCachedModelIds([...ids]);
}

export function unmarkModelCached(modelId: string): void {
  persistCachedModelIds(loadCachedModelIds().filter((id) => id !== modelId));
}

function persistCachedModelIds(ids: string[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(ids));
  } catch {
    // Brak localStorage — status offline pozostanie nieznany, nic więcej.
  }
}
