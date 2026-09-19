/** Wykrywanie wsparcia WebGPU — warunek konieczny do uruchomienia modelu lokalnie. */

export type WebGPUStatus = 'unknown' | 'checking' | 'supported' | 'unsupported';

export interface WebGPUReport {
  status: WebGPUStatus;
  /** Powód braku wsparcia w języku polskim (do wyświetlenia użytkownikowi). */
  reason?: string;
  /** Nazwa karty/sterownika, jeśli przeglądarka ją udostępnia. */
  adapterLabel?: string;
  /** Czy obsługiwane jest f16 — modele `q4f16_1` wymagają tego rozszerzenia. */
  supportsF16?: boolean;
}

/**
 * Sprawdza dostępność WebGPU bez inicjalizowania modelu.
 * Nie rzuca wyjątków — zawsze zwraca raport gotowy do pokazania w UI.
 */
export async function detectWebGPU(): Promise<WebGPUReport> {
  if (typeof navigator === 'undefined' || navigator.gpu === undefined) {
    return {
      status: 'unsupported',
      reason:
        'Ta przeglądarka nie udostępnia WebGPU. Użyj Chrome 113+, Edge 113+ lub Safari 18+ na komputerze.',
    };
  }

  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter === null) {
      return {
        status: 'unsupported',
        reason:
          'WebGPU jest dostępne, ale nie udało się uzyskać karty graficznej. Sprawdź, czy akceleracja sprzętowa jest włączona w ustawieniach przeglądarki.',
      };
    }

    const supportsF16 = adapter.features.has('shader-f16');
    const label = readAdapterLabel(adapter);

    return {
      status: 'supported',
      supportsF16,
      ...(label ? { adapterLabel: label } : {}),
      ...(supportsF16
        ? {}
        : {
            reason:
              'Karta nie obsługuje rozszerzenia shader-f16 — dostępne będą wyłącznie modele w wariancie „(f32)”.',
          }),
    };
  } catch (error) {
    return {
      status: 'unsupported',
      reason: `Inicjalizacja WebGPU nie powiodła się: ${
        error instanceof Error ? error.message : 'nieznany błąd'
      }`,
    };
  }
}

/** `adapter.info` jest dostępne tylko w części przeglądarek — czytamy defensywnie. */
function readAdapterLabel(adapter: GPUAdapter): string | undefined {
  const info: GPUAdapterInfo | undefined = 'info' in adapter ? adapter.info : undefined;
  if (info === undefined) return undefined;
  const parts = [info.vendor, info.architecture, info.device].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** Przybliżona ilość pamięci urządzenia (GB) — używana do rekomendacji modelu. */
export function deviceMemoryGb(): number | undefined {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined;
}
