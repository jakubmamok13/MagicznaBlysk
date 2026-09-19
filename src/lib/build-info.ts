/** Informacje o wersji aplikacji i środowisku — do diagnostyki zgłoszeń. */

export const BUILD_ID: string = __BUILD_ID__;
export const BUILD_TIME: string = __BUILD_TIME__;

export interface FailureReport {
  fileName: string;
  reason: string;
  details: string;
}

/**
 * Buduje tekst do wklejenia w zgłoszeniu błędu.
 * Zawiera wersję aplikacji (żeby wykluczyć starą kopię z cache PWA),
 * dane przeglądarki i techniczne szczegóły awarii.
 */
export function buildDiagnostics(failures: readonly FailureReport[]): string {
  const lines = [
    `CognitiveDeck build ${BUILD_ID} (${BUILD_TIME})`,
    `URL: ${typeof location === 'undefined' ? '?' : location.href}`,
    `UA: ${typeof navigator === 'undefined' ? '?' : navigator.userAgent}`,
    `Języki: ${typeof navigator === 'undefined' ? '?' : navigator.languages.join(', ')}`,
    `Promise.withResolvers: ${
      typeof (Promise as { withResolvers?: unknown }).withResolvers === 'function'
        ? 'dostępne'
        : 'BRAK'
    }`,
    `Worker: ${typeof Worker === 'undefined' ? 'BRAK' : 'dostępny'}`,
    '',
  ];

  for (const failure of failures) {
    lines.push(`Plik: ${failure.fileName}`, `Powód: ${failure.reason}`, `Szczegóły: ${failure.details}`, '');
  }

  return lines.join('\n');
}

/** Kopiuje tekst do schowka; zwraca `false`, gdy przeglądarka odmówi. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Safari bez gestu użytkownika albo brak uprawnień — próbujemy dalej.
  }
  return false;
}
