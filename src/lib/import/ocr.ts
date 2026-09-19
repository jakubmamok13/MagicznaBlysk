import type { PDFDocumentProxy } from 'pdfjs-dist';

import { installPromiseWithResolvers } from '@/lib/polyfills';
import { errorMessage } from '@/lib/utils';

import { ExtractionError, errorDetails, normalizeWhitespace } from './extract';

/**
 * Rozpoznawanie tekstu (OCR) w zeskanowanych PDF-ach.
 *
 * Cały proces jest lokalny: rdzeń WASM i dane językowe serwujemy z własnej
 * domeny (`scripts/setup-ocr.mjs`), więc treść dokumentu nie trafia do żadnej
 * usługi zewnętrznej. Po pierwszym użyciu pliki są w cache i OCR działa offline.
 */

export type OcrLanguage = 'pol';

export interface OcrProgress {
  /** Numer przetwarzanej strony, liczony od 1. */
  page: number;
  pageCount: number;
  /** Postęp całości 0–1. */
  ratio: number;
  message: string;
}

export interface OcrOptions {
  language?: OcrLanguage;
  /** Maksymalna liczba stron — OCR jest wolny, więc warto mieć bezpiecznik. */
  maxPages?: number;
  onProgress?: (progress: OcrProgress) => void;
  signal?: AbortSignal;
}

export interface OcrResult {
  text: string;
  pagesProcessed: number;
  /** Strony, których nie udało się rozpoznać. */
  failedPages: number;
  warnings: string[];
}

/** Szerokość renderowania strony przed OCR — kompromis jakość/pamięć. */
const TARGET_WIDTH_PX = 1600;

/** Powyżej tylu stron pytamy użytkownika, zamiast mielić w nieskończoność. */
export const DEFAULT_MAX_OCR_PAGES = 30;

/** Ścieżki do plików OCR — uwzględniają podkatalog (GitHub Pages). */
function assetPaths(): { workerPath: string; corePath: string; langPath: string } {
  const base = import.meta.env.BASE_URL;
  return {
    workerPath: `${base}tesseract/worker.min.js`,
    corePath: `${base}tesseract`,
    langPath: `${base}tessdata`,
  };
}

/**
 * Uruchamia OCR na zeskanowanym PDF-ie: renderuje każdą stronę do bitmapy
 * i przepuszcza ją przez tesseract.
 */
export async function ocrPdf(file: File, options: OcrOptions = {}): Promise<OcrResult> {
  const language = options.language ?? 'pol';
  const maxPages = options.maxPages ?? DEFAULT_MAX_OCR_PAGES;
  const report = (progress: OcrProgress): void => options.onProgress?.(progress);
  const isAborted = (): boolean => options.signal?.aborted === true;

  installPromiseWithResolvers();
  report({ page: 0, pageCount: 0, ratio: 0, message: 'Przygotowanie silnika OCR…' });

  const [pdfjsLib, tesseract] = await Promise.all([import('pdfjs-dist'), import('tesseract.js')]);

  const paths = assetPaths();
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data });

  let worker: Awaited<ReturnType<typeof tesseract.createWorker>> | null = null;
  const warnings: string[] = [];
  const pages: string[] = [];
  let failedPages = 0;

  try {
    const pdf = await loadingTask.promise;
    const pageCount = Math.min(pdf.numPages, maxPages);
    if (pdf.numPages > maxPages) {
      warnings.push(
        `Rozpoznano pierwsze ${maxPages} z ${pdf.numPages} stron — reszta zajęłaby zbyt dużo czasu.`,
      );
    }

    report({ page: 0, pageCount, ratio: 0.02, message: 'Wczytywanie modelu językowego…' });
    worker = await tesseract.createWorker(language, 1, {
      workerPath: paths.workerPath,
      corePath: paths.corePath,
      langPath: paths.langPath,
      // Tylko silnik LSTM — mniejszy rdzeń i lepsza jakość dla druku.
      legacyCore: false,
      legacyLang: false,
    });

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      if (isAborted()) {
        warnings.push('Rozpoznawanie przerwane — zapisano strony przetworzone do tej pory.');
        break;
      }

      report({
        page: pageNumber,
        pageCount,
        ratio: 0.05 + (0.95 * (pageNumber - 1)) / pageCount,
        message: `Rozpoznawanie strony ${pageNumber} z ${pageCount}…`,
      });

      try {
        const image = await renderPageToCanvas(pdf, pageNumber);
        const { data: recognized } = await worker.recognize(image.canvas);
        const pageText = normalizeWhitespace(recognized.text ?? '');
        if (pageText.length > 0) pages.push(pageText);
        image.release();
      } catch (error) {
        failedPages += 1;
        console.warn(`[CognitiveDeck] OCR strony ${pageNumber} nie powiódł się:`, errorMessage(error));
      }
    }

    if (pages.length === 0) {
      throw new ExtractionError(
        failedPages > 0
          ? 'Nie udało się rozpoznać tekstu na żadnej stronie.'
          : 'OCR nie znalazł tekstu — sprawdź, czy skan jest czytelny i nie jest obrócony.',
        `[ocr] strony: ${pageCount}, nieudane: ${failedPages}`,
      );
    }

    if (failedPages > 0) {
      warnings.push(`Nie udało się rozpoznać ${failedPages} stron.`);
    }

    report({ page: pageCount, pageCount, ratio: 1, message: 'Gotowe' });
    return {
      text: pages.join('\n\n'),
      pagesProcessed: pages.length,
      failedPages,
      warnings,
    };
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    throw new ExtractionError(
      `Rozpoznawanie tekstu nie powiodło się: ${errorMessage(error)}`,
      errorDetails(error, 'ocr'),
    );
  } finally {
    await worker?.terminate();
    await loadingTask.destroy();
  }
}

interface RenderedPage {
  canvas: HTMLCanvasElement;
  /** Zwalnia pamięć bitmapy — istotne na telefonie przy wielu stronach. */
  release: () => void;
}

/** Renderuje stronę PDF do canvasu w rozdzielczości wystarczającej dla OCR. */
async function renderPageToCanvas(
  pdf: PDFDocumentProxy,
  pageNumber: number,
): Promise<RenderedPage> {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(3, Math.max(1, TARGET_WIDTH_PX / baseViewport.width));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) {
    throw new Error('Przeglądarka nie udostępniła kontekstu 2D do renderowania strony.');
  }

  // Białe tło: skany bywają przezroczyste, a OCR gubi wtedy kontrast.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvas, canvasContext: context, viewport }).promise;

  return {
    canvas,
    release: () => {
      page.cleanup();
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}
