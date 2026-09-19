import { db, type Deck, type Flashcard, type StudyDocument } from './db';
import { startOfDay } from './srs';

export interface DeckSummary {
  deck: Deck;
  documentId: number;
  documentTitle: string;
  /** Wszystkie fiszki w talii. */
  total: number;
  /** Fiszki gotowe do powtórki teraz. */
  due: number;
  /** Fiszki jeszcze nieprzerobione (0 powtórek). */
  fresh: number;
  /** Fiszki z ustabilizowanym odstępem (>= 21 dni). */
  mature: number;
  /** Fiszki wymagające uwagi (leech). */
  leeches: number;
  /** Najbliższy termin powtórki, jeśli nic nie jest zaległe. */
  nextDueAt: Date | null;
}

export interface DashboardTotals {
  documents: number;
  decks: number;
  cards: number;
  due: number;
  mature: number;
  reviewedToday: number;
}

export interface DashboardSnapshot {
  documents: StudyDocument[];
  decks: DeckSummary[];
  totals: DashboardTotals;
}

const MATURE_INTERVAL_DAYS = 21;
const LEECH_THRESHOLD = 4;

/**
 * Jedno zapytanie zbiorcze dla panelu. Dexie (`useLiveQuery`) odświeża wynik
 * automatycznie po każdej zmianie w dotkniętych tabelach.
 */
export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const now = new Date();
  const [documents, decks, cards, sessions] = await Promise.all([
    db.documents.orderBy('createdAt').reverse().toArray(),
    db.decks.orderBy('createdAt').reverse().toArray(),
    db.cards.toArray(),
    db.studySessions.toArray(),
  ]);

  const titleById = new Map(documents.map((document) => [document.id, document.title]));
  const byDeck = new Map<number, Flashcard[]>();
  for (const card of cards) {
    const bucket = byDeck.get(card.deckId);
    if (bucket === undefined) byDeck.set(card.deckId, [card]);
    else bucket.push(card);
  }

  const summaries: DeckSummary[] = decks.map((deck) => {
    const deckCards = byDeck.get(deck.id) ?? [];
    const due = deckCards.filter((card) => card.dueDate.getTime() <= now.getTime());
    const upcoming = deckCards
      .filter((card) => card.dueDate.getTime() > now.getTime())
      .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

    return {
      deck,
      documentId: deck.documentId,
      documentTitle: titleById.get(deck.documentId) ?? 'Materiał usunięty',
      total: deckCards.length,
      due: due.length,
      fresh: deckCards.filter((card) => card.repetitions === 0 && card.leechCount === 0).length,
      mature: deckCards.filter((card) => card.interval >= MATURE_INTERVAL_DAYS).length,
      leeches: deckCards.filter((card) => card.leechCount >= LEECH_THRESHOLD).length,
      nextDueAt: due.length > 0 ? null : (upcoming[0]?.dueDate ?? null),
    };
  });

  const todayStart = startOfDay(now).getTime();
  const reviewedToday = sessions
    .filter((session) => session.updatedAt.getTime() >= todayStart)
    .reduce((sum, session) => sum + session.totalReviewed, 0);

  return {
    documents,
    decks: summaries,
    totals: {
      documents: documents.length,
      decks: decks.length,
      cards: cards.length,
      due: cards.filter((card) => card.dueDate.getTime() <= now.getTime()).length,
      mature: cards.filter((card) => card.interval >= MATURE_INTERVAL_DAYS).length,
      reviewedToday,
    },
  };
}

/** Rozkład fiszek na najbliższe 7 dni — mini-prognoza obciążenia. */
export interface ForecastDay {
  label: string;
  count: number;
}

export async function getForecast(days = 7): Promise<ForecastDay[]> {
  const cards = await db.cards.toArray();
  const base = startOfDay();
  const formatter = new Intl.DateTimeFormat('pl-PL', { weekday: 'short' });

  return Array.from({ length: days }, (_, index) => {
    const dayStart = new Date(base.getTime());
    dayStart.setDate(dayStart.getDate() + index);
    const dayEnd = new Date(dayStart.getTime());
    dayEnd.setDate(dayEnd.getDate() + 1);

    const count = cards.filter((card) => {
      const due = card.dueDate.getTime();
      if (index === 0) return due < dayEnd.getTime();
      return due >= dayStart.getTime() && due < dayEnd.getTime();
    }).length;

    return { label: index === 0 ? 'dziś' : formatter.format(dayStart), count };
  });
}
