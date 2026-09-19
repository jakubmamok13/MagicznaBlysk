import { installPromiseWithResolvers } from '@/lib/polyfills';
import { errorMessage } from '@/lib/utils';

import {
  detectFormat,
  FORMAT_LABELS,
  MAX_FILE_BYTES,
  titleFromFileName,
  unsupportedReason,
  type SupportedFormat,
} from './formats';
import { htmlToMarkdown } from './html-to-markdown';

export interface ExtractedDocument {
  fileName: string;
  title: string;
  format: SupportedFormat;
  text: string;
  /** Uwagi nieblokujące, np. PDF bez warstwy tekstowej na części stron. */
  warnings: string[];
  /**
   * PDF bez warstwy tekstowej (skan). Tekst jest pusty, dopóki użytkownik
   * nie uruchomi OCR — dlatego trzymamy też oryginalny plik.
   */
  needsOcr?: boolean;
  /** Oryginalny plik — potrzebny do rozpoznawania tekstu. */
  source?: File;
}

export interface ExtractionFailure {
  fileName: string;
  /** Komunikat dla użytkownika. */
  reason: string;
  /** Szczegóły techniczne (nazwa błędu, etap, początek stosu) do zgłoszenia. */
  details: string;
}

/** Błąd niosący dodatkowo dane diagnostyczne. */
export class ExtractionError extends Error {
  readonly details: string;

  constructor(message: string, details: string) {
    super(message);
    this.name = 'ExtractionError';
    this.details = details;
  }
}

/**
 * Składa zwięzły opis techniczny błędu. Sam komunikat bywa bezużyteczny
 * („undefined is not a function”), więc dokładamy etap i początek stosu —
 * to jedyna droga, by zdiagnozować awarię na cudzym urządzeniu.
 */
export function errorDetails(error: unknown, phase: string): string {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const frames = (normalized.stack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .join(' <- ');
  return `[${phase}] ${normalized.name}: ${normalized.message}${frames ? ` @ ${frames}` : ''}`;
}

export interface ExtractionProgress {
  fileName: string;
  /** Numer pliku (od 1) i łączna liczba plików. */
  fileNumber: number;
  fileCount: number;
  /** Postęp w obrębie pliku 0–1 (PDF: strony). */
  ratio: number;
  message: string;
}

/* -------------------------------------------------------------------------- */
/*                                Pojedynczy plik                             */
/* -------------------------------------------------------------------------- */

/** Wyciąga tekst z jednego pliku. Rzuca błąd z komunikatem dla użytkownika. */
export async function extractFromFile(
  file: File,
  onProgress?: (ratio: number, message: string) => void,
): Promise<ExtractedDocument> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      `Plik jest za duży (${(file.size / 1024 / 1024).toFixed(1)} MB). Limit to ${
        MAX_FILE_BYTES / 1024 / 1024
      } MB.`,
    );
  }

  const format = detectFormat(file.name);
  if (format === null) throw new Error(unsupportedReason(file.name));

  const warnings: string[] = [];
  let text: string;

  switch (format) {
    case 'text':
    case 'markdown':
      onProgress?.(0.5, 'Odczyt pliku…');
      text = await file.text();
      break;
    case 'pdf':
      text = await extractPdf(file, warnings, onProgress);
      break;
    case 'docx':
      text = await extractDocx(file, warnings, onProgress);
      break;
  }

  const cleaned = normalizeWhitespace(text);

  /**
   * Pusty PDF to niemal zawsze skan. Zamiast odrzucać plik, oznaczamy go jako
   * wymagający OCR — użytkownik decyduje, czy uruchomić rozpoznawanie tekstu.
   */
  if (cleaned.length === 0 && format === 'pdf') {
    onProgress?.(1, 'Skan bez warstwy tekstowej');
    return {
      fileName: file.name,
      title: titleFromFileName(file.name),
      format,
      text: '',
      warnings: ['Ten PDF nie zawiera warstwy tekstowej — to skan. Uruchom OCR, aby odczytać treść.'],
      needsOcr: true,
      source: file,
    };
  }

  if (cleaned.length === 0) {
    throw new Error('Plik nie zawiera tekstu.');
  }

  onProgress?.(1, 'Gotowe');
  return {
    fileName: file.name,
    title: titleFromFileName(file.name),
    format,
    text: cleaned,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*                                     PDF                                    */
/* -------------------------------------------------------------------------- */

async function extractPdf(
  file: File,
  warnings: string[],
  onProgress?: (ratio: number, message: string) => void,
): Promise<string> {
  // Polyfill musi być gotowy przed wczytaniem pdf.js (Safari < 17.4).
  installPromiseWithResolvers();

  // Biblioteka pdf.js waży ~1 MB — ładujemy ją dopiero przy imporcie PDF-a.
  const pdfjs = await import('pdfjs-dist');

  /**
   * Własny worker zamiast samego `workerSrc`: nasz wrapper instaluje polyfill
   * także w zakresie workera, gdzie pdf.js również woła `Promise.withResolvers()`.
   *
   * Dodatkowo ustawiamy `workerSrc`. Gdy utworzenie workera się nie powiedzie
   * (zdarza się na iOS), pdf.js sam przechodzi na tryb bez workera i parsuje
   * dokument w wątku głównym — wolniej, ale użytkownik dostaje swój tekst
   * zamiast komunikatu o błędzie.
   */
  pdfjs.GlobalWorkerOptions.workerSrc = (
    await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  ).default;

  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('../../workers/pdf.worker.ts', import.meta.url), {
      name: 'cognitivedeck-pdf',
    });
    pdfjs.GlobalWorkerOptions.workerPort = worker;
  } catch {
    // Brak workera nie jest błędem krytycznym — pdf.js użyje wątku głównego.
    pdfjs.GlobalWorkerOptions.workerPort = null;
  }

  const data = new Uint8Array(await file.arrayBuffer());

  // `destroy()` żyje na zadaniu ładowania, nie na dokumencie — trzymamy referencję,
  // żeby na pewno zwolnić worker pdf.js po zakończeniu (także przy błędzie).
  const loadingTask = pdfjs.getDocument({ data });
  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (error) {
    await loadingTask.destroy();
    worker?.terminate();
    throw new ExtractionError(
      describePdfError(errorMessage(error)),
      errorDetails(error, 'otwieranie dokumentu'),
    );
  }

  const pages: string[] = [];
  const pageErrors: string[] = [];
  let emptyPages = 0;

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      onProgress?.(pageNumber / pdf.numPages, `Strona ${pageNumber} z ${pdf.numPages}…`);
      // Błąd jednej strony nie może przekreślać całego dokumentu.
      try {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const pageText = joinTextItems(content?.items);
        if (pageText.trim().length === 0) emptyPages += 1;
        else pages.push(pageText);
        page.cleanup();
      } catch (error) {
        pageErrors.push(errorDetails(error, `strona ${pageNumber}`));
      }
    }
  } finally {
    await loadingTask.destroy();
    // Port workera nie jest współdzielony między importami — zwalniamy go.
    worker?.terminate();
    pdfjs.GlobalWorkerOptions.workerPort = null;
  }

  // Żadnego tekstu i same błędy — dopiero to jest porażką całego pliku.
  if (pages.length === 0 && pageErrors.length > 0) {
    throw new ExtractionError(
      describePdfError(pageErrors[0] ?? 'Nie udało się odczytać stron PDF-a.'),
      pageErrors.slice(0, 2).join(' || '),
    );
  }
  if (pageErrors.length > 0) {
    warnings.push(
      `Pominięto ${pageErrors.length} stron z powodu błędów odczytu — reszta tekstu została wczytana.`,
    );
  }

  // Gdy pusty jest cały dokument, komunikat o skanie doda `extractFromFile`.
  if (emptyPages > 0 && emptyPages < pdf.numPages) {
    warnings.push(
      `${emptyPages} z ${pdf.numPages} stron nie zawiera tekstu (prawdopodobnie skany lub grafiki).`,
    );
  }

  return pages.join('\n\n');
}

/**
 * Zamienia surowy błąd pdf.js na komunikat, z którym użytkownik coś zrobi.
 * „undefined is not a function” oznacza w praktyce zbyt starą przeglądarkę.
 */
export function describePdfError(message: string): string {
  if (/password/i.test(message)) {
    return 'PDF jest zabezpieczony hasłem — usuń hasło i spróbuj ponownie.';
  }
  if (/is not a function|undefined is not|not supported/i.test(message)) {
    return (
      'Ta przeglądarka jest zbyt stara, aby odczytać PDF. Zaktualizuj system ' +
      '(na iPhonie potrzebny jest iOS 16.4 lub nowszy) albo wczytaj plik na komputerze.'
    );
  }
  if (/invalid|corrupt|structure/i.test(message)) {
    return 'Plik PDF jest uszkodzony lub ma nietypową strukturę — spróbuj zapisać go ponownie.';
  }
  return `Nie udało się otworzyć PDF-a: ${message}`;
}

/** Element tekstowy pdf.js — interesują nas tylko te pola. */
interface PdfTextLike {
  str?: unknown;
  hasEOL?: unknown;
}

/**
 * Składa fragmenty tekstu w linie i akapity.
 * pdf.js zwraca osobne elementy dla każdego przebiegu czcionki, a znacznik
 * `hasEOL` wyznacza koniec wiersza — bez tego cały PDF byłby jednym ciągiem.
 */
export function joinTextItems(items: unknown): string {
  // pdf.js mógłby zwrócić coś innego niż tablica — `for..of` rzuciłby wtedy
  // „undefined is not a function”, czyli komunikat bez żadnej wartości.
  if (!Array.isArray(items)) return '';

  let line = '';
  const lines: string[] = [];

  for (const item of items) {
    // pdf.js miesza w tej liście elementy tekstowe ze znacznikami struktury
    // (TextMarkedContent) — te drugie nie mają pola `str`.
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as PdfTextLike;
    if (typeof entry.str !== 'string') continue;
    line += entry.str;
    if (entry.hasEOL === true) {
      lines.push(line);
      line = '';
    }
  }
  if (line.length > 0) lines.push(line);

  return mergeHyphenatedLines(lines);
}

/**
 * Łączy wiersze w akapity: pusty wiersz kończy akapit, a przeniesienie
 * wyrazu myślnikiem na końcu wiersza sklejamy z powrotem.
 */
function mergeHyphenatedLines(lines: string[]): string {
  const paragraphs: string[] = [];
  let current = '';

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (trimmed.length === 0) {
      if (current.trim().length > 0) paragraphs.push(current.trim());
      current = '';
      continue;
    }

    if (current.length === 0) {
      current = trimmed;
      continue;
    }

    if (/[\p{L}]-$/u.test(current)) {
      current = `${current.slice(0, -1)}${trimmed}`;
    } else {
      current = `${current} ${trimmed}`;
    }
  }

  if (current.trim().length > 0) paragraphs.push(current.trim());
  return paragraphs.join('\n\n');
}

/* -------------------------------------------------------------------------- */
/*                                    DOCX                                    */
/* -------------------------------------------------------------------------- */

async function extractDocx(
  file: File,
  warnings: string[],
  onProgress?: (ratio: number, message: string) => void,
): Promise<string> {
  onProgress?.(0.3, 'Rozpakowywanie dokumentu Word…');
  const mammoth = await import('mammoth');
  const arrayBuffer = await file.arrayBuffer();

  try {
    const result = await mammoth.convertToHtml({ arrayBuffer });
    onProgress?.(0.8, 'Konwersja treści…');

    // Mammoth zgłasza m.in. nieobsługiwane osadzone obiekty — nie blokują importu.
    const notable = result.messages.filter((message) => message.type === 'warning').length;
    if (notable > 0) {
      warnings.push(`Pominięto ${notable} elementów formatowania (np. obrazy lub pola).`);
    }

    return htmlToMarkdown(result.value);
  } catch (error) {
    throw new Error(`Nie udało się odczytać pliku Word: ${errorMessage(error)}`);
  }
}

/* -------------------------------------------------------------------------- */
/*                               Wiele plików                                 */
/* -------------------------------------------------------------------------- */

export interface BatchExtraction {
  documents: ExtractedDocument[];
  failures: ExtractionFailure[];
}

/**
 * Przetwarza pliki po kolei. Błąd jednego pliku nie przerywa pozostałych —
 * użytkownik dostaje wszystko, co dało się odczytać, oraz listę problemów.
 */
export async function extractFromFiles(
  files: readonly File[],
  onProgress?: (progress: ExtractionProgress) => void,
): Promise<BatchExtraction> {
  const documents: ExtractedDocument[] = [];
  const failures: ExtractionFailure[] = [];

  for (const [index, file] of files.entries()) {
    const report = (ratio: number, message: string): void =>
      onProgress?.({
        fileName: file.name,
        fileNumber: index + 1,
        fileCount: files.length,
        ratio,
        message,
      });

    report(0, 'Przygotowanie…');
    try {
      documents.push(await extractFromFile(file, report));
    } catch (error) {
      failures.push({
        fileName: file.name,
        reason: errorMessage(error),
        details:
          error instanceof ExtractionError
            ? error.details
            : errorDetails(error, 'odczyt pliku'),
      });
    }
  }

  return { documents: disambiguateTitles(documents), failures };
}

/**
 * Pliki o tej samej nazwie, a innym rozszerzeniu (np. `wyklad.pdf` i
 * `wyklad.docx`) dałyby dwa materiały o identycznym tytule. Dopisujemy format,
 * żeby dało się je rozróżnić na liście.
 */
export function disambiguateTitles(documents: ExtractedDocument[]): ExtractedDocument[] {
  const counts = new Map<string, number>();
  for (const document of documents) {
    counts.set(document.title, (counts.get(document.title) ?? 0) + 1);
  }

  return documents.map((document) =>
    (counts.get(document.title) ?? 0) > 1
      ? { ...document, title: `${document.title} (${FORMAT_LABELS[document.format]})` }
      : document,
  );
}

/** Scala kilka dokumentów w jeden materiał z nagłówkami sekcji. */
export function mergeDocuments(documents: readonly ExtractedDocument[], title: string): string {
  if (documents.length === 1) return documents[0]?.text ?? '';
  return documents
    .map((document) => `## ${document.title}\n\n${document.text}`)
    .join('\n\n')
    .replace(/^/, `# ${title}\n\n`);
}

/** Normalizacja: spójne końce linii, bez nadmiarowych pustych wierszy. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
