import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileUp, Loader2, Plus, Sparkles } from 'lucide-react';

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
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { createDocumentWithDeck } from '@/lib/db';
import { SAMPLE_DOCUMENT_CONTENT, SAMPLE_DOCUMENT_TITLE } from '@/lib/sample';
import { countWords, readingTimeMinutes } from '@/lib/text';
import { errorMessage, pluralize } from '@/lib/utils';

const MIN_CONTENT_LENGTH = 200;
const MAX_FILE_SIZE = 2 * 1024 * 1024;

export interface ImportDocumentDialogProps {
  /** Wariant przycisku otwierającego okno. */
  trigger?: React.ReactNode;
}

/** Okno dodania materiału: wklejenie tekstu lub wczytanie pliku .txt/.md. */
export function ImportDocumentDialog({ trigger }: ImportDocumentDialogProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { toast } = useToast();

  const words = countWords(content);
  const tooShort = content.trim().length < MIN_CONTENT_LENGTH;

  const reset = useCallback((): void => {
    setTitle('');
    setContent('');
    setSaving(false);
  }, []);

  const handleFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = event.target.files?.[0];
      if (file === undefined) return;

      if (file.size > MAX_FILE_SIZE) {
        toast({
          title: 'Plik jest zbyt duży',
          description: 'Maksymalny rozmiar to 2 MB — podziel materiał na części.',
          variant: 'error',
        });
        return;
      }

      try {
        const text = await file.text();
        setContent(text);
        if (title.trim().length === 0) {
          setTitle(file.name.replace(/\.(txt|md|markdown)$/i, ''));
        }
      } catch (error) {
        toast({ title: 'Nie udało się odczytać pliku', description: errorMessage(error), variant: 'error' });
      } finally {
        if (fileInputRef.current !== null) fileInputRef.current.value = '';
      }
    },
    [title, toast],
  );

  const fillSample = useCallback((): void => {
    setTitle(SAMPLE_DOCUMENT_TITLE);
    setContent(SAMPLE_DOCUMENT_CONTENT);
  }, []);

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (tooShort || saving) return;

      setSaving(true);
      try {
        const { documentId } = await createDocumentWithDeck({
          title: title.trim().length > 0 ? title : 'Materiał bez tytułu',
          rawContent: content,
        });
        toast({
          title: 'Materiał dodany',
          description: 'Możesz teraz wygenerować kompendium i fiszki lokalnym modelem.',
          variant: 'success',
        });
        setOpen(false);
        reset();
        navigate(`/documents/${documentId}`);
      } catch (error) {
        toast({ title: 'Nie udało się zapisać materiału', description: errorMessage(error), variant: 'error' });
        setSaving(false);
      }
    },
    [content, navigate, reset, saving, title, toast, tooShort],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
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
            Wklej notatki, rozdział podręcznika lub wykład. Treść zostaje zapisana wyłącznie w
            pamięci tej przeglądarki.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
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
              <div className="flex items-center gap-1">
                <Button type="button" variant="ghost" size="sm" onClick={fillSample}>
                  <Sparkles className="size-3.5" />
                  Wstaw przykład
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileUp className="size-3.5" />
                  Wczytaj plik
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.md,.markdown,text/plain,text/markdown"
                  className="hidden"
                  onChange={(event) => void handleFile(event)}
                />
              </div>
            </div>
            <Textarea
              id="document-content"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="Wklej tutaj tekst materiału (markdown jest obsługiwany)…"
              className="min-h-[220px] font-mono text-xs leading-relaxed"
              required
            />
            <p className="text-xs text-muted-foreground">
              {content.trim().length === 0
                ? `Minimum ${MIN_CONTENT_LENGTH} znaków, aby model miał z czego tworzyć fiszki.`
                : `${pluralize(words, 'słowo', 'słowa', 'słów')} · ok. ${readingTimeMinutes(content)} min czytania${
                    tooShort ? ' · materiał jest jeszcze zbyt krótki' : ''
                  }`}
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Anuluj
            </Button>
            <Button type="submit" disabled={tooShort || saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Zapisz materiał
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
