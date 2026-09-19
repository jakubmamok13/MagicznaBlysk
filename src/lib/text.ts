/** Narzędzia do przygotowania materiału źródłowego dla modelu lokalnego. */

/** Domyślna długość fragmentu w znakach (~700 tokenów, bezpieczne dla okna 4k). */
export const DEFAULT_CHUNK_SIZE = 2400;

/** Nakładka między fragmentami, by nie ucinać myśli na granicy. */
export const DEFAULT_CHUNK_OVERLAP = 180;

export interface TextChunk {
  index: number;
  content: string;
}

/**
 * Dzieli tekst na fragmenty na granicach akapitów (a w razie potrzeby zdań),
 * tak aby żaden fragment nie przekroczył `maxChars`.
 */
export function chunkText(
  raw: string,
  maxChars: number = DEFAULT_CHUNK_SIZE,
  overlap: number = DEFAULT_CHUNK_OVERLAP,
): TextChunk[] {
  const normalized = raw.replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0) return [];
  if (normalized.length <= maxChars) return [{ index: 0, content: normalized }];

  const blocks = splitIntoBlocks(normalized, maxChars);
  const chunks: string[] = [];
  let current = '';

  for (const block of blocks) {
    const candidate = current.length === 0 ? block : `${current}\n\n${block}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current.length > 0) chunks.push(current);
    current = overlap > 0 && chunks.length > 0 ? withOverlap(chunks[chunks.length - 1] ?? '', block, overlap) : block;
  }

  if (current.trim().length > 0) chunks.push(current);

  return chunks.map((content, index) => ({ index, content: content.trim() }));
}

function withOverlap(previous: string, block: string, overlap: number): string {
  const tail = previous.slice(-overlap);
  const boundary = tail.search(/[.!?]\s/);
  const prefix = boundary >= 0 ? tail.slice(boundary + 1).trim() : tail.trim();
  return prefix.length > 0 ? `${prefix}\n\n${block}` : block;
}

/** Rozbija tekst na akapity, a nadmiarowo długie akapity na zdania. */
function splitIntoBlocks(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const blocks: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      blocks.push(paragraph);
      continue;
    }
    for (const sentence of splitIntoSentences(paragraph)) {
      if (sentence.length <= maxChars) {
        blocks.push(sentence);
        continue;
      }
      // Ostatnia linia obrony: twarde cięcie bardzo długiego zdania.
      for (let i = 0; i < sentence.length; i += maxChars) {
        blocks.push(sentence.slice(i, i + maxChars));
      }
    }
  }

  return blocks;
}

/** Znacznik zastępczy dla kropki w skrócie (obszar prywatnego użytku Unicode). */
const DOT_SENTINEL = '\uE000';

/** Prosty podział na zdania, uwzględniający polskie skróty (np., tzn., itd.). */
export function splitIntoSentences(text: string): string[] {
  const protectedText = text.replace(
    /\b(np|tzn|tj|itd|itp|m\.in|dr|prof|ok|ur|zm|str|ust|art)\./gi,
    (match) => match.replaceAll('.', DOT_SENTINEL),
  );

  return protectedText
    .split(/(?<=[.!?])\s+(?=[A-ZĄĆĘŁŃÓŚŹŻ0-9„"])/)
    .map((sentence) => sentence.replaceAll(DOT_SENTINEL, '.').trim())
    .filter((sentence) => sentence.length > 0);
}

/** Normalizacja do porównywania cytatów (spacje, cudzysłowy, wielkość liter). */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/[„”“"»«]/g, '"')
    .replace(/[’']/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('pl-PL');
}

export interface ExcerptVerification {
  /** Cytat po weryfikacji — zawsze fragment obecny w źródle (lub pusty). */
  excerpt: string;
  /** Czy cytat występuje w źródle dosłownie (po normalizacji). */
  verbatim: boolean;
  /**
   * Czy udało się umocować cytat w materiale źródłowym.
   * `false` oznacza konfabulację modelu — taką fiszkę odrzucamy.
   */
  matched: boolean;
}

/**
 * Weryfikuje, czy cytat modelu faktycznie występuje w materiale źródłowym.
 * Gdy nie występuje dosłownie, podmienia go na najbardziej pokrywające się
 * zdanie ze źródła. Gdy nie ma żadnego pokrycia, zwraca `matched: false` —
 * warstwa walidacji odrzuca wtedy całą fiszkę (wymóg: cytat musi być prawdziwy).
 */
export function verifyExcerpt(excerpt: string, source: string): ExcerptVerification {
  const candidate = excerpt.trim().replace(/^["„»]|["”«]$/g, '').trim();
  if (candidate.length === 0) {
    return { excerpt: '', verbatim: false, matched: false };
  }

  const normalizedSource = normalizeForMatch(source);
  const normalizedCandidate = normalizeForMatch(candidate);

  if (normalizedCandidate.length > 0 && normalizedSource.includes(normalizedCandidate)) {
    return { excerpt: candidate, verbatim: true, matched: true };
  }

  const best = findBestSentence(normalizedCandidate, source);
  return best === null
    ? { excerpt: '', verbatim: false, matched: false }
    : { excerpt: best, verbatim: false, matched: true };
}

/** Wyszukuje zdanie źródłowe o największym pokryciu słów z cytatem. */
function findBestSentence(normalizedCandidate: string, source: string): string | null {
  const candidateTokens = new Set(tokenize(normalizedCandidate));
  if (candidateTokens.size === 0) return null;

  let bestSentence: string | null = null;
  let bestScore = 0;

  for (const sentence of splitIntoSentences(source)) {
    const tokens = tokenize(normalizeForMatch(sentence));
    if (tokens.length === 0) continue;
    let overlap = 0;
    for (const token of tokens) {
      if (candidateTokens.has(token)) overlap += 1;
    }
    const score = overlap / Math.max(candidateTokens.size, tokens.length);
    if (score > bestScore) {
      bestScore = score;
      bestSentence = sentence.trim();
    }
  }

  // Poniżej 35% pokrycia uznajemy, że w źródle nie ma odpowiednika.
  return bestScore >= 0.35 ? bestSentence : null;
}

/**
 * Tokenizacja z lekkim stemmingiem: polski jest silnie fleksyjny, więc
 * „syntezie” i „syntezę” muszą trafić na ten sam token, inaczej porównanie
 * pokrycia dawałoby fałszywe negatywy.
 */
function tokenize(text: string): string[] {
  return text
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 2)
    .map(stem);
}

const DIACRITICS: Record<string, string> = {
  ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z',
};

function stem(token: string): string {
  const ascii = token.replace(/[ąćęłńóśźż]/g, (char) => DIACRITICS[char] ?? char);
  return ascii.slice(0, 6);
}

export function countWords(text: string): number {
  const matches = text.trim().match(/[\p{L}\p{N}'’-]+/gu);
  return matches ? matches.length : 0;
}

/** Szacowany czas czytania w minutach (200 słów/min). */
export function readingTimeMinutes(text: string): number {
  return Math.max(1, Math.round(countWords(text) / 200));
}
