/**
 * Obsługa składni luk: `{{c1::ukryta fraza}}` oraz
 * `{{c1::ukryta fraza::podpowiedź}}` (kompatybilnie z Anki).
 */

/**
 * Wzorzec luki. Tworzymy go za każdym razem od nowa — współdzielone wyrażenie
 * z flagą `g` przenosi stan `lastIndex` między wywołaniami, co gubiłoby luki.
 */
function clozePattern(): RegExp {
  return /\{\{c(\d+)::([\s\S]*?)\}\}/g;
}

/** Wersja bez flagi `g` — bezstanowa, do sprawdzenia obecności luki. */
const CLOZE_TEST = /\{\{c\d+::[\s\S]*?\}\}/;

export interface ClozeDeletion {
  /** Numer luki (`c1` → 1). */
  ordinal: number;
  /** Ukryty tekst. */
  answer: string;
  /** Opcjonalna podpowiedź wyświetlana zamiast luki. */
  hint?: string;
}

export type ClozeSegment =
  | { kind: 'text'; value: string }
  | { kind: 'cloze'; value: string; ordinal: number; hint?: string };

/** Czy tekst zawiera przynajmniej jedną poprawną lukę. */
export function hasCloze(text: string): boolean {
  return CLOZE_TEST.test(text);
}

/** Rozbija tekst na segmenty do wyrenderowania w widoku nauki. */
export function parseCloze(text: string): ClozeSegment[] {
  const segments: ClozeSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(clozePattern())) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ kind: 'text', value: text.slice(lastIndex, index) });
    }
    const ordinal = Number.parseInt(match[1] ?? '1', 10);
    // Składnia `{{c1::odpowiedź::podpowiedź}}` — wszystko po drugim `::` to podpowiedź.
    const [answer = '', ...hintParts] = (match[2] ?? '').split('::');
    const hint = hintParts.join('::').trim();
    segments.push({
      kind: 'cloze',
      value: answer.trim(),
      ordinal: Number.isFinite(ordinal) ? ordinal : 1,
      ...(hint ? { hint } : {}),
    });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ kind: 'text', value: text.slice(lastIndex) });
  }

  return segments;
}

/** Lista luk w kolejności wystąpienia. */
export function extractDeletions(text: string): ClozeDeletion[] {
  return parseCloze(text)
    .filter((segment): segment is Extract<ClozeSegment, { kind: 'cloze' }> => segment.kind === 'cloze')
    .map(({ ordinal, value, hint }) => ({ ordinal, answer: value, ...(hint ? { hint } : {}) }));
}

/** Tekst z lukami zamienionymi na `[...]` — używany w podglądzie listy fiszek. */
export function maskCloze(text: string, placeholder = '[…]'): string {
  return parseCloze(text)
    .map((segment) => (segment.kind === 'text' ? segment.value : segment.hint ?? placeholder))
    .join('');
}

/** Tekst z lukami rozwiniętymi do pełnej treści. */
export function revealCloze(text: string): string {
  return parseCloze(text)
    .map((segment) => segment.value)
    .join('');
}

/**
 * Naprawia typowe odstępstwa modelu od składni luk:
 * `{{c1:tekst}}`, `{c1::tekst}`, `[[c1::tekst]]` → `{{c1::tekst}}`.
 * Zwraca `null`, jeśli nie udało się odzyskać żadnej luki.
 */
export function repairClozeSyntax(text: string): string | null {
  if (hasCloze(text)) return text;

  const repaired = text
    .replace(/\{\{\s*c(\d+)\s*:\s*([^{}]+?)\s*\}\}/g, '{{c$1::$2}}')
    .replace(/\[\[\s*c(\d+)\s*::?\s*([^\][]+?)\s*\]\]/g, '{{c$1::$2}}')
    .replace(/(?<!\{)\{\s*c(\d+)\s*::?\s*([^{}]+?)\s*\}(?!\})/g, '{{c$1::$2}}');

  return hasCloze(repaired) ? repaired : null;
}
