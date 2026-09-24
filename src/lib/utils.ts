import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const dateFormatter = new Intl.DateTimeFormat('pl-PL', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat('pl-PL', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDate(date: Date): string {
  return dateFormatter.format(date);
}

export function formatDateTime(date: Date): string {
  return dateTimeFormatter.format(date);
}

/** Polska odmiana rzeczownika po liczbie, np. „1 fiszka / 2 fiszki / 5 fiszek”. */
export function plural(count: number, one: string, few: string, many: string): string {
  const abs = Math.abs(count);
  const lastTwo = abs % 100;
  const last = abs % 10;
  if (abs === 1) return one;
  if (lastTwo >= 12 && lastTwo <= 14) return many;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export function pluralize(count: number, one: string, few: string, many: string): string {
  return `${count} ${plural(count, one, few, many)}`;
}

/** Formatuje rozmiar w bajtach (postęp pobierania modelu). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/** Skraca tekst do podanej długości, dodając wielokropek. */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

/** Typowany odczyt błędu z bloku `catch` (unknown → tekst). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Nieznany błąd';
  }
}

/** Maksymalna długość tytułu materiału wyświetlanego w interfejsie. */
const MAX_DISPLAY_NAME = 80;

/**
 * Porządkuje nazwę do wyświetlenia.
 *
 * iOS zapisuje fragment tekstu do Plików pod nazwą wziętą z treści, zakodowaną
 * procentowo i w postaci NFD (np. `notatke%CC%A8` zamiast „notatkę”), często
 * z przełamaniami wierszy. Dekodujemy, normalizujemy do NFC, zwijamy białe znaki
 * i przycinamy do rozsądnej długości.
 */
export function cleanDisplayName(raw: string): string {
  let value = raw;

  if (/%[0-9a-f]{2}/i.test(value)) {
    try {
      value = decodeURIComponent(value);
    } catch {
      // Nazwa ucięta w środku sekwencji (np. „…%2”) — dekodujemy tyle, ile się da.
      try {
        value = decodeURIComponent(value.replace(/%[0-9a-f]?$/i, ''));
      } catch {
        // Zostawiamy oryginał — lepsza brzydka nazwa niż wyjątek.
      }
    }
  }

  value = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  return value.length > MAX_DISPLAY_NAME ? truncate(value, MAX_DISPLAY_NAME) : value;
}

/**
 * Nazwy nadawane przez system, a nie przez człowieka — np. załącznik z Poczty
 * na iPhonie („att.KD7RUw3Mjo8W3hVlYmx-GxjLm…”) albo UUID. Rozpoznajemy je po
 * długim „słowie” mieszającym litery i cyfry, którego nikt nie wpisuje ręcznie.
 */
export function looksMachineGenerated(name: string): boolean {
  if (/^att\./i.test(name)) return true;
  return name
    .split(/[\s._-]+/)
    // „Farmakologia2024” to ludzka nazwa; „KD7RUw3Mjo8W” — już nie: litery
    // i cyfry przeplatają się wielokrotnie.
    .some((token) => token.length >= 12 && (token.match(/\d\p{L}|\p{L}\d/gu) ?? []).length >= 3);
}

/** Pierwsza sensowna linia treści jako tytuł (gdy nazwa pliku nic nie mówi). */
export function titleFromText(text: string): string {
  const line = text
    .split('\n')
    .map((candidate) => candidate.replace(/^[#>*\-\s\d.)]+/, '').trim())
    .find((candidate) => /\p{L}{3}/u.test(candidate));
  if (line === undefined) return '';
  const cleaned = cleanDisplayName(line);
  return cleaned.length > 60 ? `${cleaned.slice(0, 59).trimEnd()}…` : cleaned;
}
