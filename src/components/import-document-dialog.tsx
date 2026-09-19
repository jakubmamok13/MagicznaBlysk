import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  FileUp,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { createDocumentWithDeck } from '@/lib/db';
import {
  extractFromFiles,
  mergeDocuments,
  type ExtractedDocument,
  type ExtractionFailure,
  type ExtractionProgress,
} from '@/lib/import/extract';
import { FILE_ACCEPT_ATTRIBUTE, FORMAT_LABELS } from '@/lib/import/formats';
import { SAMPLE_DOCUMENT_CONTENT, SAMPLE_DOCUMENT_TITLE } from '@/lib/sample';
import { countWords, readingTimeMinutes } from '@/lib/text';
import { errorMessage, pluralize } from '@/lib/utils';

const MIN_CONTENT_LENGTH = 200;

export interface ImportDocumentDialogProps {
  trigger?: React.ReactNode;
}

/**
 * Dodawanie materiałów: wklejony tekst albo pliki (.txt, .md, .pdf, .docx).
 * Pliki są przetwarzane w przeglądarce — nic nie jest wysyłane na serwer.
 */
export function ImportDocumentDialog({ trigger }: ImportDocumentDialogProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  // Zakładka „wklej tekst”
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  // Zakładka „pliki”
  const [documents, setDocuments] = useState<ExtractedDocument[]>([]);
  const [failures, setFailures] = useState<ExtractionFailure[]>([]);
  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  const [mergeIntoOne, setMergeIntoOne] = useState(false);
  const [mergedTitle, setMergedTitle] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const words = countWords(content);
  const pasteTooShort = content.trim().length < MIN_CONTENT_LENGTH;

  const reset = useCallback((): void => {
    setTitle('');
    setContent('');
    setDocuments([]);
    setFailures([]);
    setProgress(null);
    setMergeIntoOne(false);
    setMergedTitle('');
    setSaving(false);
  }, []);

  /* ----------------------------- Wybór plików ---------------------------- */

  const handleFiles = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const selected = Array.from(event.target.files ?? []);
      if (fileInputRef.current !== null) fileInputRef.current.value = '';
      if (selected.length === 0) return;

      setProgress({
        fileName: selected[0]?.name ?? '',
        fileNumber: 1,
        fileCount: selected.length,
        ratio: 0,
        message: 'Przygotowanie…',
      });

      const result = await extractFromFiles(selected, setProgress);
      setProgress(null);
      setDocuments((current) => [...current, ...result.documents]);
      setFailures((current) => [...current, ...result.failures]);

      if (result.documents.length > 1 && mergedTitle.length === 0) {
        setMergedTitle(result.documents[0]?.title ?? '');
      }
      if (result.failures.length > 0 && result.documents.length === 0) {
        toast({
          title: 'Nie udało się odczytać plików',
          description: result.failures[0]?.reason,
          variant: 'error',
        });
      }
    },
    [mergedTitle.length, toast],
  );

  const removeDocument = useCallback((index: number): void => {
    setDocuments((current) => current.filter((_, i) => i !== index));
  }, []);

  /* -------------------------------- Zapis -------------------------------- */

  const saveFiles = useCallback(async (): Promise<void> => {
    if (documents.length === 0 || saving) return;
    setSaving(true);

    try {
      if (mergeIntoOne && documents.length > 1) {
        const finalTitle = mergedTitle.trim() || documents[0]?.title || 'Materiał zbiorczy';
        const { documentId } = await createDocumentWithDeck({
          title: finalTitle,
          rawContent: mergeDocuments(documents, finalTitle),
        });
        toast({
          title: `Połączono ${pluralize(documents.length, 'plik', 'pliki', 'plików')} w jeden materiał`,
          variant: 'success',
        });
        setOpen(false);
        reset();
        navigate(`/documents/${documentId}`);
        return;
      }

      let firstId: number | null = null;
      for (const document of documents) {
        const { documentId } = await createDocumentWithDeck({
          title: document.title,
          rawContent: document.text,
        });
        firstId ??= documentId;
      }

      toast({
        title: `Dodano ${pluralize(documents.length, 'materiał', 'materiały', 'materiałów')}`,
        description:
          documents.length > 1 ? 'Każdy plik ma własną talię fiszek.' : undefined,
        variant: 'success',
      });
      setOpen(false);
      reset();
      if (firstId !== null) navigate(`/documents/${firstId}`);
    } catch (error) {
      toast({ title: 'Nie udało się zapisać', description: errorMessage(error), variant: 'error' });
      setSaving(false);
    }
  }, [documents, mergeIntoOne, mergedTitle, navigate, reset, saving, toast]);

  const savePasted = useCallback(
    async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (pasteTooShort || saving) return;

      setSaving(true);
      try {
        const { documentId } = await createDocumentWithDeck({
          title: title.trim().length > 0 ? title : 'Materiał bez tytułu',
          rawContent: content,
        });
        toast({ title: 'Materiał dodany', variant: 'success' });
        setOpen(false);
        reset();
        navigate(`/documents/${documentId}`);
      } catch (error) {
        toast({ title: 'Nie udało się zapisać', description: errorMessage(error), variant: 'error' });
        setSaving(false);
      }
    },
    [content, navigate, pasteTooShort, reset, saving, title, toast],
  );

  const totalWords = documents.reduce((sum, document) => sum + countWords(document.text), 0);
  const extracting = progress !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (extracting) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <Plus className="size-4" />
            Dodaj materiał
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Nowy materiał do nauki</DialogTitle>
          <DialogDescription>
            Wczytaj pliki lub wklej tekst. Wszystko jest przetwarzane lokalnie — treść nie opuszcza
            tego urządzenia.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="files">
          <TabsList>
            <TabsTrigger value="files">
              <FileUp className="size-3.5" />
              Pliki
            </TabsTrigger>
            <TabsTrigger value="paste">
              <FileText className="size-3.5" />
              Wklej tekst
            </TabsTrigger>
          </TabsList>

          {/* ------------------------------ PLIKI ----------------------------- */}
          <TabsContent value="files" className="space-y-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={extracting}
              className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center transition-colors hover:bg-accent/50 disabled:opacity-60"
            >
              <FileUp className="size-6 text-muted-foreground" />
              <span className="text-sm font-medium">Wybierz pliki</span>
              <span className="text-xs text-muted-foreground">
                PDF, Word (.docx), tekst (.txt) i markdown (.md) · można wybrać wiele naraz
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={FILE_ACCEPT_ATTRIBUTE}
              multiple
              className="hidden"
              onChange={(event) => void handleFiles(event)}
            />

            {extracting && (
              <div className="space-y-1.5" aria-live="polite">
                <Progress value={Math.round(progress.ratio * 100)} />
                <p className="flex justify-between gap-2 text-xs text-muted-foreground">
                  <span className="truncate">
                    {progress.fileName} — {progress.message}
                  </span>
                  <span className="tabular-nums">
                    {progress.fileNumber}/{progress.fileCount}
                  </span>
                </p>
              </div>
            )}

            {documents.length > 0 && (
              <div className="space-y-2">
                <div className="max-h-56 space-y-1.5 overflow-y-auto">
                  {documents.map((document, index) => (
                    <div
                      key={`${document.fileName}-${index}`}
                      className="flex items-start gap-2 rounded-md border p-2.5"
                    >
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{document.fileName}</p>
                        <p className="text-xs text-muted-foreground">
                          {FORMAT_LABELS[document.format]} ·{' '}
                          {pluralize(countWords(document.text), 'słowo', 'słowa', 'słów')} · ok.{' '}
                          {readingTimeMinutes(document.text)} min
                        </p>
                        {document.warnings.map((warning) => (
                          <p key={warning} className="mt-1 flex items-start gap-1 text-xs text-warning">
                            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                            {warning}
                          </p>
                        ))}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => removeDocument(index)}
                        aria-label={`Usuń ${document.fileName}`}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>

                <p className="text-xs text-muted-foreground">
                  Razem: {pluralize(documents.length, 'plik', 'pliki', 'plików')} ·{' '}
                  {pluralize(totalWords, 'słowo', 'słowa', 'słów')}
                </p>

                {documents.length > 1 && (
                  <div className="space-y-2 rounded-md border p-3">
                    <label className="flex cursor-pointer items-start gap-2.5">
                      <input
                        type="checkbox"
                        checked={mergeIntoOne}
                        onChange={(event) => setMergeIntoOne(event.target.checked)}
                        className="mt-0.5 size-4"
                      />
                      <span className="text-sm">
                        <span className="block font-medium">Połącz w jeden materiał</span>
                        <span className="block text-xs text-muted-foreground">
                          {mergeIntoOne
                            ? 'Powstanie jedna talia; pliki trafią do niej jako sekcje.'
                            : 'Domyślnie każdy plik dostaje własny materiał i własną talię.'}
                        </span>
                      </span>
                    </label>
                    {mergeIntoOne && (
                      <Input
                        value={mergedTitle}
                        onChange={(event) => setMergedTitle(event.target.value)}
                        placeholder="Tytuł połączonego materiału"
                        aria-label="Tytuł połączonego materiału"
                      />
                    )}
                  </div>
                )}
              </div>
            )}

            {failures.length > 0 && (
              <div className="space-y-1.5 rounded-md bg-destructive/10 p-2.5">
                <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                  <AlertTriangle className="size-3.5" />
                  Pominięto {pluralize(failures.length, 'plik', 'pliki', 'plików')}
                </p>
                {failures.map((failure) => (
                  <p key={failure.fileName} className="text-xs text-destructive">
                    <span className="font-medium">{failure.fileName}</span> — {failure.reason}
                  </p>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setFailures([])}
                >
                  <X className="size-3" />
                  Ukryj
                </Button>
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={extracting}>
                Anuluj
              </Button>
              <Button onClick={() => void saveFiles()} disabled={documents.length === 0 || saving || extracting}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                {documents.length > 1 && !mergeIntoOne
                  ? `Dodaj ${documents.length} materiały`
                  : 'Dodaj materiał'}
              </Button>
            </DialogFooter>
          </TabsContent>

          {/* --------------------------- WKLEJONY TEKST ------------------------ */}
          <TabsContent value="paste">
            <form onSubmit={(event) => void savePasted(event)} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="document-title">Tytuł</Label>
                <Input
                  id="document-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="np. Fizjologia układu krążenia — wykład 3"
                  autoComplete="off"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor="document-content">Treść materiału</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setTitle(SAMPLE_DOCUMENT_TITLE);
                      setContent(SAMPLE_DOCUMENT_CONTENT);
                    }}
                  >
                    <Sparkles className="size-3.5" />
                    Wstaw przykład
                  </Button>
                </div>
                <Textarea
                  id="document-content"
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="Wklej tutaj tekst materiału (markdown jest obsługiwany)…"
                  className="min-h-[200px] font-mono text-xs leading-relaxed"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  {content.trim().length === 0
                    ? `Minimum ${MIN_CONTENT_LENGTH} znaków, aby model miał z czego tworzyć fiszki.`
                    : `${pluralize(words, 'słowo', 'słowa', 'słów')} · ok. ${readingTimeMinutes(content)} min czytania${
                        pasteTooShort ? ' · materiał jest jeszcze zbyt krótki' : ''
                      }`}
                </p>
              </div>

              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  Anuluj
                </Button>
                <Button type="submit" disabled={pasteTooShort || saving}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  Zapisz materiał
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>
        </Tabs>

        {documents.length === 0 && failures.length === 0 && !extracting && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="outline">PDF</Badge>
            <span>skany bez warstwy tekstowej wymagają OCR i nie zostaną wczytane.</span>
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
