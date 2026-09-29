/**
 * Wykrywanie ubicia strony w trakcie generowania.
 *
 * Gdy modelowi zabraknie pamięci, iOS nie zgłasza błędu, tylko zabija całą
 * kartę („Wielokrotnie wystąpił problem z …”). Kod aplikacji nie ma wtedy szansy
 * nic powiedzieć. Zostawiamy więc znacznik w localStorage na czas generowania:
 * jeśli przy następnym uruchomieniu znacznik wciąż jest, poprzednia sesja
 * zakończyła się w trakcie pracy modelu — mówimy to wprost i ostrzegamy przed
 * ponowną próbą tym samym modelem, zamiast pozwolić wpaść w tę samą awarię.
 */

const RUNNING_KEY = 'cognitivedeck:generation-running';
const CRASHES_KEY = 'cognitivedeck:generation-crashes';

export interface CrashReport {
  modelId: string;
  startedAt: number;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Brak localStorage (tryb prywatny) — ochrona po prostu nie działa.
  }
}

function readCrashes(): Record<string, number> {
  try {
    const parsed = JSON.parse(read(CRASHES_KEY) ?? '{}') as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
    );
  } catch {
    return {};
  }
}

/** Zwykłe zamknięcie karty to nie awaria — `pagehide` nie zachodzi przy ubiciu przez system. */
function clearOnPageHide(): void {
  write(RUNNING_KEY, null);
}

export function markGenerationStarted(modelId: string): void {
  write(RUNNING_KEY, JSON.stringify({ modelId, startedAt: Date.now() }));
  if (typeof window !== 'undefined') window.addEventListener('pagehide', clearOnPageHide);
}

export function markGenerationFinished(): void {
  write(RUNNING_KEY, null);
  if (typeof window !== 'undefined') window.removeEventListener('pagehide', clearOnPageHide);
}

/**
 * Wywoływane raz przy starcie aplikacji. Zwraca informację o przerwanym
 * generowaniu (i zapamiętuje awarię danego modelu) albo `null`.
 */
export function consumeCrashReport(): CrashReport | null {
  const raw = read(RUNNING_KEY);
  if (raw === null) return null;
  write(RUNNING_KEY, null);
  try {
    const parsed = JSON.parse(raw) as Partial<CrashReport>;
    if (typeof parsed.modelId !== 'string') return null;
    const crashes = readCrashes();
    crashes[parsed.modelId] = (crashes[parsed.modelId] ?? 0) + 1;
    write(CRASHES_KEY, JSON.stringify(crashes));
    return { modelId: parsed.modelId, startedAt: parsed.startedAt ?? 0 };
  } catch {
    return null;
  }
}

/** Ile razy strona padła w trakcie generowania tym modelem na tym urządzeniu. */
export function crashCount(modelId: string): number {
  return readCrashes()[modelId] ?? 0;
}

/** Po udanym generowaniu model nie jest już podejrzany. */
export function clearCrashes(modelId: string): void {
  const crashes = readCrashes();
  if (!(modelId in crashes)) return;
  delete crashes[modelId];
  write(CRASHES_KEY, JSON.stringify(crashes));
}

let startupCrash: CrashReport | null | undefined;

/**
 * Raport z poprzedniej sesji, odczytany raz na uruchomienie aplikacji
 * (bezpieczne przy wielokrotnym wywołaniu, np. w StrictMode).
 */
export function getStartupCrash(): CrashReport | null {
  startupCrash ??= consumeCrashReport();
  return startupCrash;
}
