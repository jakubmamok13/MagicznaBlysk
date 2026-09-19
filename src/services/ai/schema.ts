import { CARD_TYPES, type CardType, type DraftCard } from '@/lib/db';
import { repairClozeSyntax } from '@/lib/cloze';
import { verifyExcerpt } from '@/lib/text';

/**
 * Schemat JSON wymuszany na modelu przez WebLLM
 * (`response_format: { type: 'json_object', schema }`), dzięki czemu dekodowanie
 * jest ograniczone gramatyką i nie musimy „prosić” modelu o poprawny JSON.
 */
export function buildGenerationSchema(allowedTypes: readonly CardType[]): string {
  return JSON.stringify({
    type: 'object',
    properties: {
      summary: { type: 'string' },
      cards: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...allowedTypes] },
            front: { type: 'string' },
            back: { type: 'string' },
            sourceExcerpt: { type: 'string' },
            explanation: { type: 'string' },
          },
          required: ['type', 'front', 'back', 'sourceExcerpt', 'explanation'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'cards'],
    additionalProperties: false,
  });
}

/** Surowa, niezweryfikowana fiszka zwrócona przez model. */
interface RawCard {
  type: string;
  front: string;
  back: string;
  sourceExcerpt: string;
  explanation: string;
}

interface RawGenerationPayload {
  summary: string;
  cards: RawCard[];
}

export interface ParsedGeneration {
  summary: string;
  cards: DraftCard[];
  /** Liczba fiszek odrzuconych na etapie walidacji (braki pól, duplikaty). */
  rejected: number;
  /** Liczba fiszek, których cytat nie występował dosłownie i został skorygowany. */
  correctedExcerpts: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function isCardType(value: string): value is CardType {
  return (CARD_TYPES as readonly string[]).includes(value);
}

/**
 * Wyciąga obiekt JSON z odpowiedzi modelu. Gramatyka WebLLM zwraca czysty JSON,
 * ale zostawiamy zabezpieczenie na bloki ```json oraz tekst poboczny.
 */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const candidates = [withoutFence];
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start >= 0 && end > start) {
    candidates.push(withoutFence.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Próbujemy następnego kandydata.
    }
  }

  throw new Error('Model nie zwrócił poprawnego obiektu JSON.');
}

function toRawPayload(value: unknown): RawGenerationPayload {
  if (!isRecord(value)) {
    throw new Error('Odpowiedź modelu nie jest obiektem JSON.');
  }

  const cardsValue = value['cards'];
  const cards: RawCard[] = Array.isArray(cardsValue)
    ? cardsValue.filter(isRecord).map((card) => ({
        type: readString(card, 'type').toLowerCase(),
        front: readString(card, 'front'),
        back: readString(card, 'back'),
        sourceExcerpt: readString(card, 'sourceExcerpt'),
        explanation: readString(card, 'explanation'),
      }))
    : [];

  return { summary: readString(value, 'summary'), cards };
}

export interface ValidationContext {
  /** Fragment źródłowy, z którego pochodzą fiszki (do weryfikacji cytatów). */
  source: string;
  allowedTypes: readonly CardType[];
  /** Znormalizowane awersy już przyjętych fiszek — deduplikacja między fragmentami. */
  seenFronts: Set<string>;
}

/**
 * Waliduje i porządkuje odpowiedź modelu:
 * odrzuca niekompletne fiszki, naprawia składnię luk, weryfikuje cytaty
 * i usuwa duplikaty. Zwraca tylko dane gotowe do zapisania w bazie.
 */
export function parseGenerationResponse(raw: string, context: ValidationContext): ParsedGeneration {
  const payload = toRawPayload(extractJsonObject(raw));
  const cards: DraftCard[] = [];
  let rejected = 0;
  let correctedExcerpts = 0;

  for (const candidate of payload.cards) {
    const card = normalizeCard(candidate, context);
    if (card === null) {
      rejected += 1;
      continue;
    }

    const key = dedupeKey(card.front);
    if (context.seenFronts.has(key)) {
      rejected += 1;
      continue;
    }

    const verification = verifyExcerpt(card.sourceExcerpt, context.source);
    if (!verification.matched) {
      // Wymóg twardy: bez dosłownego umocowania w źródle fiszka nie wchodzi do talii.
      rejected += 1;
      continue;
    }
    if (!verification.verbatim) correctedExcerpts += 1;

    context.seenFronts.add(key);
    cards.push({ ...card, sourceExcerpt: verification.excerpt });
  }

  return { summary: payload.summary, cards, rejected, correctedExcerpts };
}

function normalizeCard(raw: RawCard, context: ValidationContext): DraftCard | null {
  if (raw.front.length < 3 || raw.back.length === 0) return null;

  const requestedType = isCardType(raw.type) ? raw.type : 'basic';
  const type = context.allowedTypes.includes(requestedType)
    ? requestedType
    : (context.allowedTypes[0] ?? 'basic');

  if (type === 'cloze') {
    const front = repairClozeSyntax(raw.front);
    if (front === null) {
      // Model obiecał lukę, ale jej nie zrobił — degradujemy do pytania otwartego.
      if (!context.allowedTypes.includes('basic')) return null;
      return {
        type: 'basic',
        front: raw.front,
        back: raw.back,
        sourceExcerpt: raw.sourceExcerpt,
        explanation: raw.explanation,
      };
    }
    return {
      type: 'cloze',
      front,
      back: raw.back,
      sourceExcerpt: raw.sourceExcerpt,
      explanation: raw.explanation,
    };
  }

  return {
    type,
    front: raw.front,
    back: raw.back,
    sourceExcerpt: raw.sourceExcerpt,
    explanation: raw.explanation,
  };
}

export function dedupeKey(front: string): string {
  return front.toLocaleLowerCase('pl-PL').replace(/\s+/g, ' ').trim();
}
