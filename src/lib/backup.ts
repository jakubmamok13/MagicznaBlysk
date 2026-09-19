import { db, type Deck, type Flashcard, type StudyDocument } from './db';

/** Format kopii zapasowej — pełny zrzut lokalnej bazy do pliku JSON. */
export interface BackupFile {
  format: 'cognitivedeck-backup';
  version: 1;
  exportedAt: string;
  documents: StudyDocument[];
  decks: Deck[];
  cards: Flashcard[];
}

export async function exportBackup(): Promise<BackupFile> {
  const [documents, decks, cards] = await Promise.all([
    db.documents.toArray(),
    db.decks.toArray(),
    db.cards.toArray(),
  ]);

  return {
    format: 'cognitivedeck-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    documents,
    decks,
    cards,
  };
}

/** Pobiera kopię jako plik .json bez udziału jakiegokolwiek serwera. */
export async function downloadBackup(): Promise<void> {
  const backup = await exportBackup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `cognitivedeck-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export interface ImportSummary {
  documents: number;
  decks: number;
  cards: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/**
 * Wczytuje kopię zapasową, nadając nowe identyfikatory, żeby nie nadpisać
 * istniejących danych. Rekordy o nieznanym kształcie są pomijane.
 */
export async function importBackup(raw: string): Promise<ImportSummary> {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed['format'] !== 'cognitivedeck-backup') {
    throw new Error('To nie jest plik kopii zapasowej CognitiveDeck.');
  }

  const documents = Array.isArray(parsed['documents']) ? parsed['documents'] : [];
  const decks = Array.isArray(parsed['decks']) ? parsed['decks'] : [];
  const cards = Array.isArray(parsed['cards']) ? parsed['cards'] : [];

  return db.transaction('rw', db.documents, db.decks, db.cards, async () => {
    const documentIdMap = new Map<number, number>();
    const deckIdMap = new Map<number, number>();
    const summary: ImportSummary = { documents: 0, decks: 0, cards: 0 };

    for (const entry of documents) {
      if (!isRecord(entry) || typeof entry['title'] !== 'string') continue;
      const oldId = typeof entry['id'] === 'number' ? entry['id'] : null;
      const newId = await db.documents.add({
        title: entry['title'],
        rawContent: typeof entry['rawContent'] === 'string' ? entry['rawContent'] : '',
        structuredSummary:
          typeof entry['structuredSummary'] === 'string' ? entry['structuredSummary'] : '',
        createdAt: toDate(entry['createdAt']),
      });
      if (oldId !== null) documentIdMap.set(oldId, newId);
      summary.documents += 1;
    }

    for (const entry of decks) {
      if (!isRecord(entry) || typeof entry['name'] !== 'string') continue;
      const oldDocumentId = typeof entry['documentId'] === 'number' ? entry['documentId'] : null;
      const mappedDocumentId =
        oldDocumentId === null ? undefined : documentIdMap.get(oldDocumentId);
      if (mappedDocumentId === undefined) continue;

      const oldId = typeof entry['id'] === 'number' ? entry['id'] : null;
      const newId = await db.decks.add({
        documentId: mappedDocumentId,
        name: entry['name'],
        createdAt: toDate(entry['createdAt']),
      });
      if (oldId !== null) deckIdMap.set(oldId, newId);
      summary.decks += 1;
    }

    for (const entry of cards) {
      if (!isRecord(entry) || typeof entry['front'] !== 'string') continue;
      const oldDeckId = typeof entry['deckId'] === 'number' ? entry['deckId'] : null;
      const mappedDeckId = oldDeckId === null ? undefined : deckIdMap.get(oldDeckId);
      if (mappedDeckId === undefined) continue;

      const type = entry['type'];
      await db.cards.add({
        deckId: mappedDeckId,
        type: type === 'cloze' || type === 'case' ? type : 'basic',
        front: entry['front'],
        back: typeof entry['back'] === 'string' ? entry['back'] : '',
        sourceExcerpt: typeof entry['sourceExcerpt'] === 'string' ? entry['sourceExcerpt'] : '',
        explanation: typeof entry['explanation'] === 'string' ? entry['explanation'] : '',
        interval: typeof entry['interval'] === 'number' ? entry['interval'] : 0,
        repetitions: typeof entry['repetitions'] === 'number' ? entry['repetitions'] : 0,
        easeFactor: typeof entry['easeFactor'] === 'number' ? entry['easeFactor'] : 2.5,
        dueDate: toDate(entry['dueDate']),
        leechCount: typeof entry['leechCount'] === 'number' ? entry['leechCount'] : 0,
        createdAt: toDate(entry['createdAt']),
      });
      summary.cards += 1;
    }

    return summary;
  });
}

export interface StorageEstimateInfo {
  usageBytes: number;
  quotaBytes: number;
  persisted: boolean;
}

/** Zużycie miejsca na urządzeniu (wagi modelu + baza fiszek). */
export async function readStorageEstimate(): Promise<StorageEstimateInfo | null> {
  if (typeof navigator === 'undefined' || navigator.storage?.estimate === undefined) return null;
  try {
    const estimate = await navigator.storage.estimate();
    const persisted =
      navigator.storage.persisted !== undefined ? await navigator.storage.persisted() : false;
    return {
      usageBytes: estimate.usage ?? 0,
      quotaBytes: estimate.quota ?? 0,
      persisted,
    };
  } catch {
    return null;
  }
}

/** Prosi przeglądarkę o trwałe przechowywanie danych (ochrona przed czyszczeniem). */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || navigator.storage?.persist === undefined) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
