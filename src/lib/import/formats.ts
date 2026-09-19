/** Rozpoznawanie formatów plików przyjmowanych przez import materiałów. */

export type SupportedFormat = 'text' | 'markdown' | 'pdf' | 'docx';

export const ACCEPTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.pdf', '.docx'] as const;

/** Atrybut `accept` dla pola wyboru plików. */
export const FILE_ACCEPT_ATTRIBUTE = [
  ...ACCEPTED_EXTENSIONS,
  'text/plain',
  'text/markdown',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
].join(',');

/** Limit pojedynczego pliku — chroni pamięć przeglądarki na telefonie. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Format rozpoznajemy po rozszerzeniu, a nie po typie MIME: na Androidzie
 * i w niektórych menedżerach plików MIME bywa pusty albo błędny
 * (np. `application/octet-stream` dla .docx).
 */
export function detectFormat(fileName: string): SupportedFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.txt')) return 'text';
  return null;
}

export const FORMAT_LABELS: Record<SupportedFormat, string> = {
  text: 'tekst',
  markdown: 'markdown',
  pdf: 'PDF',
  docx: 'Word',
};

/** Nazwa pliku bez rozszerzenia — domyślny tytuł materiału. */
export function titleFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.(txt|md|markdown|pdf|docx)$/i, '');
  return withoutExtension.replace(/[_-]+/g, ' ').trim() || 'Materiał bez tytułu';
}

/** Stary format .doc nie jest obsługiwany — warto powiedzieć to wprost. */
export function unsupportedReason(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.doc')) {
    return 'Stary format .doc nie jest obsługiwany — zapisz plik jako .docx.';
  }
  if (lower.endsWith('.pptx') || lower.endsWith('.ppt')) {
    return 'Prezentacje nie są obsługiwane — skopiuj treść do pliku tekstowego.';
  }
  if (lower.endsWith('.rtf') || lower.endsWith('.odt')) {
    return 'Ten format nie jest obsługiwany — zapisz plik jako .docx, .txt lub PDF.';
  }
  return 'Obsługiwane formaty: .txt, .md, .pdf, .docx.';
}
