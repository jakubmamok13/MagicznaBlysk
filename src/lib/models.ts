/** Katalog modeli dostępnych lokalnie przez WebLLM. */

/**
 * Precyzja wag.
 * `f16` wymaga rozszerzenia WebGPU `shader-f16` — nie mają go m.in. starsze
 * układy mobilne. Dla takich urządzeń potrzebne są warianty `f32`
 * (nieco większe, ale działające wszędzie tam, gdzie jest WebGPU).
 */
export type ModelPrecision = 'f16' | 'f32';

export interface ModelOption {
  /** Identyfikator modelu w `prebuiltAppConfig` WebLLM. */
  id: string;
  label: string;
  /** Przybliżony rozmiar pobierania. */
  downloadSize: string;
  /** Wymagana pamięć VRAM podawana przez WebLLM. */
  vramMb: number;
  description: string;
  precision: ModelPrecision;
  /** Rekomendowany domyślnie na komputerze. */
  recommended?: boolean;
  /** Mieści się w limitach pamięci typowego telefonu. */
  mobileFriendly?: boolean;
}

export const MODEL_OPTIONS: readonly ModelOption[] = [
  /* ----------------------------- warianty f16 ---------------------------- */
  {
    id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    label: 'Llama 3.2 3B Instruct',
    downloadSize: '~1,8 GB',
    vramMb: 2264,
    precision: 'f16',
    description: 'Najlepsza jakość kompendium i fiszek. Na komputer z min. 8 GB RAM.',
    recommended: true,
  },
  {
    id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    label: 'Qwen 2.5 1.5B Instruct',
    downloadSize: '~1,1 GB',
    vramMb: 1629,
    precision: 'f16',
    description: 'Szybki kompromis — dobrze radzi sobie z polskim i strukturą JSON.',
  },
  {
    id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    label: 'Llama 3.2 1B Instruct',
    downloadSize: '~0,7 GB',
    vramMb: 879,
    precision: 'f16',
    description: 'Lekki model na telefon i słabsze komputery.',
    mobileFriendly: true,
  },
  {
    id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    label: 'Qwen 2.5 0.5B Instruct',
    downloadSize: '~0,5 GB',
    vramMb: 945,
    precision: 'f16',
    description: 'Najmniejszy sensowny model — ostatnia deska ratunku na telefonie.',
    mobileFriendly: true,
  },

  /* ----------------- warianty f32 (GPU bez shader-f16) ------------------- */
  {
    id: 'Llama-3.2-3B-Instruct-q4f32_1-MLC',
    label: 'Llama 3.2 3B Instruct (f32)',
    downloadSize: '~2,3 GB',
    vramMb: 2951,
    precision: 'f32',
    description: 'Wariant dla kart bez shader-f16. Największe wymagania pamięci.',
  },
  {
    id: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
    label: 'Qwen 2.5 1.5B Instruct (f32)',
    downloadSize: '~1,4 GB',
    vramMb: 1888,
    precision: 'f32',
    description: 'Zrównoważony wybór dla kart bez shader-f16.',
    recommended: true,
  },
  {
    id: 'Llama-3.2-1B-Instruct-q4f32_1-MLC',
    label: 'Llama 3.2 1B Instruct (f32)',
    downloadSize: '~0,9 GB',
    vramMb: 1129,
    precision: 'f32',
    description: 'Lekki wariant bez shader-f16 — na telefon i starsze karty.',
    mobileFriendly: true,
  },
  {
    id: 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC',
    label: 'Qwen 2.5 0.5B Instruct (f32)',
    downloadSize: '~0,6 GB',
    vramMb: 1066,
    precision: 'f32',
    description: 'Najmniejszy wariant bez shader-f16.',
    mobileFriendly: true,
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

/* -------------------------------------------------------------------------- */
/*                     Dobór modelu do możliwości urządzenia                  */
/* -------------------------------------------------------------------------- */

export interface DeviceProfile {
  /** Czy GPU obsługuje `shader-f16`. `undefined` = jeszcze nie wiadomo. */
  supportsF16: boolean | undefined;
  /** Czy to urządzenie mobilne (ostrzejsze limity pamięci na kartę). */
  isMobile: boolean;
  /** Przybliżona pamięć urządzenia w GB, jeśli przeglądarka ją podaje. */
  memoryGb: number | undefined;
}

/** Modele, które mają szansę zadziałać na tym urządzeniu. */
export function compatibleModels(profile: DeviceProfile): ModelOption[] {
  const list = MODEL_OPTIONS.filter((model) => {
    // Bez shader-f16 warianty f16 nie skompilują się w ogóle.
    if (profile.supportsF16 === false && model.precision === 'f16') return false;
    return true;
  });

  // Na telefonie ukrywamy modele, które i tak przekroczą limit pamięci karty.
  const mobileList = list.filter((model) => model.mobileFriendly === true);
  return profile.isMobile && mobileList.length > 0 ? mobileList : list;
}

/** Najlepszy domyślny model dla wykrytego urządzenia. */
export function recommendModel(profile: DeviceProfile): string {
  const available = compatibleModels(profile);
  if (available.length === 0) return DEFAULT_MODEL_ID;

  if (profile.isMobile || (profile.memoryGb !== undefined && profile.memoryGb <= 4)) {
    // Najmniejszy dostępny — na telefonie liczy się, żeby cokolwiek ruszyło.
    return [...available].sort((a, b) => a.vramMb - b.vramMb)[0]?.id ?? DEFAULT_MODEL_ID;
  }

  const recommended = available.find((model) => model.recommended === true);
  return recommended?.id ?? available[0]?.id ?? DEFAULT_MODEL_ID;
}

/** Czy wybrany model w ogóle ma szansę zadziałać na tym urządzeniu. */
export function isModelCompatible(modelId: string, profile: DeviceProfile): boolean {
  return compatibleModels(profile).some((model) => model.id === modelId);
}

/** Wykrywa urządzenie mobilne — na nim limity pamięci są znacznie ostrzejsze. */
export function detectMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (typeof uaData?.mobile === 'boolean') return uaData.mobile;
  if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) {
    return Math.min(screen.width, screen.height) < 820;
  }
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
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
