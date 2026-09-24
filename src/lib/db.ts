import Dexie, { type EntityTable } from 'dexie';

import { cleanDisplayName, looksMachineGenerated, titleFromText } from './utils';

/* -------------------------------------------------------------------------- */
/*                                   Modele                                   */
/* -------------------------------------------------------------------------- */

/** Materiał źródłowy wgrany przez użytkownika wraz z wygenerowanym kompendium. */
export interface StudyDocument {
  id: number;
  title: string;
  /** Oryginalny tekst (markdown lub czysty tekst) podany przez użytkownika. */
  rawContent: string;
  /** Kompendium akademickie wygenerowane lokalnie przez model (markdown). */
  structuredSummary: string;
  createdAt: Date;
}

/** Talia fiszek powiązana z jednym dokumentem. */
export interface Deck {
  id: number;
  documentId: number;
  name: string;
  createdAt: Date;
}

/** Dozwolone typy fiszek generowanych przez model. */
export type CardType = 'basic' | 'cloze' | 'case';

export const CARD_TYPES: readonly CardType[] = ['basic', 'cloze', 'case'] as const;

/** Pojedyncza fiszka wraz z pełnym stanem algorytmu SM-2. */
export interface Flashcard {
  id: number;
  deckId: number;
  type: CardType;
  /** Pytanie (`basic`/`case`) lub zdanie z lukami `{{c1::...}}` (`cloze`). */
  front: string;
  /** Odpowiedź. Dla `cloze` to treść luk po odsłonięciu. */
  back: string;
  /** Dosłowny cytat z materiału źródłowego potwierdzający odpowiedź. */
  sourceExcerpt: string;
  /**
   * Czy cytat udało się umocować w materiale. `false` oznacza, że model podał
   * własne sformułowanie — fiszka jest użyteczna, ale cytat wymaga sprawdzenia.
   * Starsze rekordy nie mają tego pola i traktujemy je jako zweryfikowane.
   */
  verified?: boolean;
  /** Rozszerzone wyjaśnienie „dlaczego”. */
  explanation: string;
  /** Aktualny odstęp powtórki w dniach (SM-2). */
  interval: number;
  /** Liczba poprawnych powtórek pod rząd (SM-2). */
  repetitions: number;
  /** Współczynnik łatwości (SM-2), minimum 1.3. */
  easeFactor: number;
  /** Termin najbliższej powtórki. */
  dueDate: Date;
  /** Licznik „wyciekających” fiszek — inkrementowany przy ocenie < 3. */
  leechCount: number;
  createdAt: Date;
}

/** Wznawialna sesja nauki dla danej talii. */
export interface StudySession {
  id: number;
  deckId: number;
  currentCardIndex: number;
  totalReviewed: number;
  /**
   * 0 = zakończona, 1 = aktywna.
   * IndexedDB nie indeksuje wartości logicznych, dlatego trzymamy 0/1.
   */
  isActive: 0 | 1;
  updatedAt: Date;
}

/** Dane wejściowe przy tworzeniu rekordu (klucz `id` nadaje Dexie). */
export type NewRecord<T extends { id: number }> = Omit<T, 'id'>;

/* -------------------------------------------------------------------------- */
/*                                  Baza danych                               */
/* -------------------------------------------------------------------------- */

export class CognitiveDeckDatabase extends Dexie {
  declare documents: EntityTable<StudyDocument, 'id'>;
  declare decks: EntityTable<Deck, 'id'>;
  declare cards: EntityTable<Flashcard, 'id'>;
  declare studySessions: EntityTable<StudySession, 'id'>;

  constructor() {
    super('CognitiveDeckDB');

    /**
     * Indeksujemy wyłącznie pola, po których faktycznie filtrujemy/sortujemy —
     * indeksowanie długich pól tekstowych (rawContent, front, back) znacząco
     * zwiększyłoby rozmiar bazy bez żadnej korzyści.
     */
    this.version(1).stores({
      documents: '++id, title, createdAt',
      decks: '++id, documentId, createdAt',
      cards: '++id, deckId, dueDate, type, createdAt, [deckId+dueDate]',
      studySessions: '++id, deckId, isActive, updatedAt',
    });

    /**
     * v2: te same indeksy, jednorazowe porządki w nazwach. Materiały zaimportowane
     * z iOS miały tytuły zakodowane procentowo („notatke%CC%A8…”) — dekodujemy je.
     */
    this.version(2)
      .stores({
        documents: '++id, title, createdAt',
        decks: '++id, documentId, createdAt',
        cards: '++id, deckId, dueDate, type, createdAt, [deckId+dueDate]',
        studySessions: '++id, deckId, isActive, updatedAt',
      })
      .upgrade(async (transaction) => {
        await transaction
          .table<StudyDocument, number>('documents')
          .toCollection()
          .modify((document) => {
            document.title = cleanDisplayName(document.title) || 'Materiał bez tytułu';
          });
        await transaction
          .table<Deck, number>('decks')
          .toCollection()
          .modify((deck) => {
            deck.name = cleanDisplayName(deck.name) || 'Talia bez nazwy';
          });
      });

    /**
     * v3: materiały z systemową nazwą pliku (załącznik z Poczty na iPhonie:
     * „att.KD7RUw3Mjo8W…”) dostają tytuł z pierwszej linii treści. Talia z taką
     * samą nazwą zmienia się razem z materiałem.
     */
    this.version(3)
      .stores({
        documents: '++id, title, createdAt',
        decks: '++id, documentId, createdAt',
        cards: '++id, deckId, dueDate, type, createdAt, [deckId+dueDate]',
        studySessions: '++id, deckId, isActive, updatedAt',
      })
      .upgrade(async (transaction) => {
        const renamed = new Map<number, { from: string; to: string }>();
        await transaction
          .table<StudyDocument, number>('documents')
          .toCollection()
          .modify((document) => {
            if (!looksMachineGenerated(document.title)) return;
            const title = titleFromText(document.rawContent);
            if (title === '') return;
            renamed.set(document.id, { from: document.title, to: title });
            document.title = title;
          });
        if (renamed.size === 0) return;
        await transaction
          .table<Deck, number>('decks')
          .toCollection()
          .modify((deck) => {
            const change = renamed.get(deck.documentId);
            if (change !== undefined && deck.name === change.from) deck.name = change.to;
          });
      });
  }
}

export const db = new CognitiveDeckDatabase();

/* -------------------------------------------------------------------------- */
/*                            Operacje na dokumentach                         */
/* -------------------------------------------------------------------------- */

export interface CreateDocumentInput {
  title: string;
  rawContent: string;
  /** Nazwa talii tworzonej razem z dokumentem (domyślnie tytuł dokumentu). */
  deckName?: string;
}

export interface CreateDocumentResult {
  documentId: number;
  deckId: number;
}

/** Tworzy dokument wraz z domyślną talią w jednej transakcji. */
export async function createDocumentWithDeck(
  input: CreateDocumentInput,
): Promise<CreateDocumentResult> {
  const now = new Date();
  return db.transaction('rw', db.documents, db.decks, async () => {
    const documentId = await db.documents.add({
      title: input.title.trim() || 'Materiał bez tytułu',
      rawContent: input.rawContent,
      structuredSummary: '',
      createdAt: now,
    });
    const deckId = await db.decks.add({
      documentId,
      name: (input.deckName ?? input.title).trim() || 'Talia bez nazwy',
      createdAt: now,
    });
    return { documentId, deckId };
  });
}

/** Usuwa dokument razem z taliami, fiszkami i sesjami (kaskadowo). */
export async function deleteDocumentCascade(documentId: number): Promise<void> {
  await db.transaction('rw', db.documents, db.decks, db.cards, db.studySessions, async () => {
    const deckIds = await db.decks.where('documentId').equals(documentId).primaryKeys();
    await db.cards.where('deckId').anyOf(deckIds).delete();
    await db.studySessions.where('deckId').anyOf(deckIds).delete();
    await db.decks.bulkDelete(deckIds);
    await db.documents.delete(documentId);
  });
}

export async function updateDocumentSummary(
  documentId: number,
  structuredSummary: string,
): Promise<void> {
  await db.documents.update(documentId, { structuredSummary });
}

/* -------------------------------------------------------------------------- */
/*                              Operacje na fiszkach                          */
/* -------------------------------------------------------------------------- */

/** Świeża fiszka: pierwsza powtórka zaplanowana na „teraz”. */
export interface DraftCard {
  type: CardType;
  front: string;
  back: string;
  sourceExcerpt: string;
  explanation: string;
  /** Patrz `Flashcard.verified`. */
  verified?: boolean;
}

export function toNewCard(deckId: number, draft: DraftCard): NewRecord<Flashcard> {
  const now = new Date();
  return {
    deckId,
    type: draft.type,
    front: draft.front,
    back: draft.back,
    sourceExcerpt: draft.sourceExcerpt,
    explanation: draft.explanation,
    verified: draft.verified ?? true,
    interval: 0,
    repetitions: 0,
    easeFactor: 2.5,
    dueDate: now,
    leechCount: 0,
    createdAt: now,
  };
}

/** Zapisuje wygenerowane fiszki, pomijając duplikaty awersu w obrębie talii. */
export async function addCardsToDeck(deckId: number, drafts: DraftCard[]): Promise<number> {
  if (drafts.length === 0) return 0;

  return db.transaction('rw', db.cards, async () => {
    const existing = await db.cards.where('deckId').equals(deckId).toArray();
    const seen = new Set(existing.map((card) => normalizeForDedupe(card.front)));
    const toInsert: NewRecord<Flashcard>[] = [];

    for (const draft of drafts) {
      const key = normalizeForDedupe(draft.front);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      toInsert.push(toNewCard(deckId, draft));
    }

    if (toInsert.length > 0) {
      await db.cards.bulkAdd(toInsert);
    }
    return toInsert.length;
  });
}

function normalizeForDedupe(value: string): string {
  return value.toLocaleLowerCase('pl-PL').replace(/\s+/g, ' ').trim();
}

/** Liczy fiszki gotowe do powtórki (termin <= teraz). */
export async function countDueCards(deckId?: number): Promise<number> {
  const now = new Date();
  if (deckId === undefined) {
    return db.cards.where('dueDate').belowOrEqual(now).count();
  }
  return db.cards
    .where('[deckId+dueDate]')
    .between([deckId, Dexie.minKey], [deckId, now], true, true)
    .count();
}

/** Zwraca kolejkę powtórek: najpierw najbardziej zaległe fiszki. */
export async function getDueCards(deckId: number, limit?: number): Promise<Flashcard[]> {
  const now = new Date();
  const collection = db.cards
    .where('[deckId+dueDate]')
    .between([deckId, Dexie.minKey], [deckId, now], true, true);
  const cards = limit === undefined ? await collection.toArray() : await collection.limit(limit).toArray();
  return cards.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
}

/* -------------------------------------------------------------------------- */
/*                               Sesje nauki                                  */
/* -------------------------------------------------------------------------- */

/** Zwraca aktywną sesję dla talii lub tworzy nową. */
export async function resumeOrCreateSession(deckId: number): Promise<StudySession> {
  return db.transaction('rw', db.studySessions, async () => {
    const active = await db.studySessions
      .where('deckId')
      .equals(deckId)
      .filter((session) => session.isActive === 1)
      .first();

    if (active) return active;

    const draft: NewRecord<StudySession> = {
      deckId,
      currentCardIndex: 0,
      totalReviewed: 0,
      isActive: 1,
      updatedAt: new Date(),
    };
    const id = await db.studySessions.add(draft);
    return { ...draft, id };
  });
}

export async function updateSessionProgress(
  sessionId: number,
  changes: Partial<Pick<StudySession, 'currentCardIndex' | 'totalReviewed' | 'isActive'>>,
): Promise<void> {
  await db.studySessions.update(sessionId, { ...changes, updatedAt: new Date() });
}

export async function closeSession(sessionId: number): Promise<void> {
  await db.studySessions.update(sessionId, { isActive: 0, updatedAt: new Date() });
}

/** Czyści wszystkie dane lokalne (opcja „reset” w ustawieniach). */
export async function wipeAllData(): Promise<void> {
  await db.transaction('rw', db.documents, db.decks, db.cards, db.studySessions, async () => {
    await Promise.all([
      db.cards.clear(),
      db.decks.clear(),
      db.documents.clear(),
      db.studySessions.clear(),
    ]);
  });
}
