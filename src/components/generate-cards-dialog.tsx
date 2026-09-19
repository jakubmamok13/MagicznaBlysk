import { useCallback, useRef, useState } from 'react';
import { Loader2, Sparkles, Square, Wand2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { useEngine } from '@/hooks/use-engine';
import { CARD_TYPES, type CardType, type StudyDocument } from '@/lib/db';
import { CARD_TYPE_META } from '@/lib/labels';
import { chunkText } from '@/lib/text';
import { cn, errorMessage, pluralize } from '@/lib/utils';
import { generateFromDocument, type GenerationProgress } from '@/services/ai/generate';

export interface GenerateCardsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: StudyDocument;
  deckId: number;
  /** Czy dokument ma już kompendium (wpływa na domyślną opcję nadpisania). */
  hasSummary: boolean;
}

/**
 * Okno generowania: wybór typów fiszek i intensywności, a następnie podgląd
 * postępu pracy modelu (fragment po fragmencie) z możliwością przerwania.
 */
export function GenerateCardsDialog({
  open,
  onOpenChange,
  document,
  deckId,
  hasSummary,
}: GenerateCardsDialogProps): React.JSX.Element {
  const engine = useEngine();
  const { toast } = useToast();
  const [types, setTypes] = useState<CardType[]>(['basic', 'cloze', 'case']);
  const [cardsPerChunk, setCardsPerChunk] = useState(4);
  const [regenerateSummary, setRegenerateSummary] = useState(!hasSummary);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const chunkCount = chunkText(document.rawContent).length;
  const running = progress !== null && progress.phase !== 'done' && progress.phase !== 'cancelled';

  const toggleType = useCallback((type: CardType): void => {
    setTypes((current) =>
      current.includes(type) ? current.filter((item) => item !== type) : [...current, type],
    );
  }, []);

  const handleRun = useCallback(async (): Promise<void> => {
    if (engine.status !== 'ready') {
      toast({
        title: 'Model nie jest gotowy',
        description: 'Uruchom model w panelu silnika AI, a potem wróć tutaj.',
        variant: 'error',
      });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({
      phase: 'preparing',
      chunkNumber: 0,
      chunkCount,
      cardsGenerated: 0,
      message: 'Analiza materiału…',
    });

    try {
      const result = await generateFromDocument({
        document,
        deckId,
        allowedTypes: types,
        cardsPerChunk,
        regenerateSummary,
        signal: controller.signal,
        onProgress: setProgress,
      });

      const details = [
        result.rejected > 0 ? `${result.rejected} odrzucono w walidacji` : null,
        result.correctedExcerpts > 0 ? `${result.correctedExcerpts} cytatów skorygowano` : null,
        result.failedChunks > 0 ? `${result.failedChunks} fragmentów nieudanych` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ');

      toast({
        title: result.cancelled
          ? `Przerwano — zapisano ${pluralize(result.cardsAdded, 'fiszkę', 'fiszki', 'fiszek')}`
          : `Dodano ${pluralize(result.cardsAdded, 'fiszkę', 'fiszki', 'fiszek')}`,
        ...(details.length > 0 ? { description: details } : {}),
        variant: result.cardsAdded > 0 ? 'success' : 'info',
      });

      if (!result.cancelled) onOpenChange(false);
    } catch (error) {
      toast({ title: 'Generowanie nie powiodło się', description: errorMessage(error), variant: 'error' });
    } finally {
      abortRef.current = null;
      setProgress(null);
    }
  }, [
    cardsPerChunk,
    chunkCount,
    deckId,
    document,
    engine.status,
    onOpenChange,
    regenerateSummary,
    toast,
    types,
  ]);

  const handleStop = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  const percent =
    progress === null || progress.chunkCount === 0
      ? 0
      : Math.round((progress.chunkNumber / progress.chunkCount) * 100);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (running) return; // Nie zamykamy okna w trakcie pracy modelu.
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="size-4 text-primary" />
            Generowanie fiszek lokalnie
          </DialogTitle>
          <DialogDescription>
            Materiał zostanie podzielony na {pluralize(chunkCount, 'fragment', 'fragmenty', 'fragmentów')}.
            Model pracuje na tym urządzeniu — nic nie jest wysyłane do sieci.
          </DialogDescription>
        </DialogHeader>

        {running ? (
          <div className="space-y-3" aria-live="polite">
            <Progress value={percent} indeterminate={progress.phase === 'preparing'} />
            <p className="text-sm">{progress.message}</p>
            <p className="text-xs text-muted-foreground">
              Przyjętych fiszek: {progress.cardsGenerated}
              {progress.chunkCount > 0 && ` · fragment ${progress.chunkNumber}/${progress.chunkCount}`}
            </p>
            <p className="text-xs text-muted-foreground">
              Generowanie dużego materiału na słabszym GPU może potrwać kilka minut. Okno możesz
              zostawić otwarte — postęp jest zapisywany po każdym fragmencie.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Typy fiszek</Label>
              <div className="flex flex-wrap gap-2">
                {CARD_TYPES.map((type) => {
                  const active = types.includes(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => toggleType(type)}
                      aria-pressed={active}
                      className={cn(
                        'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                        active
                          ? 'border-primary bg-primary/15 text-primary'
                          : 'border-border text-muted-foreground hover:bg-accent',
                      )}
                    >
                      {CARD_TYPE_META[type].short}
                    </button>
                  );
                })}
              </div>
              {types.length === 0 && (
                <p className="text-xs text-destructive">Wybierz co najmniej jeden typ fiszek.</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cards-per-chunk">Fiszek z jednego fragmentu</Label>
              <Select
                value={String(cardsPerChunk)}
                onValueChange={(value) => setCardsPerChunk(Number.parseInt(value, 10))}
              >
                <SelectTrigger id="cards-per-chunk">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="2">2 — tylko najważniejsze fakty</SelectItem>
                  <SelectItem value="4">4 — zalecane</SelectItem>
                  <SelectItem value="6">6 — szczegółowe pokrycie</SelectItem>
                  <SelectItem value="8">8 — maksymalna gęstość (dłużej)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Szacunkowo do {chunkCount * cardsPerChunk} fiszek przed deduplikacją.
              </p>
            </div>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3">
              <input
                type="checkbox"
                checked={regenerateSummary}
                onChange={(event) => setRegenerateSummary(event.target.checked)}
                className="mt-0.5 size-4 accent-current text-primary"
              />
              <span className="text-sm">
                <span className="block font-medium">Zbuduj kompendium na nowo</span>
                <span className="block text-xs text-muted-foreground">
                  {hasSummary
                    ? 'Nadpisze obecne kompendium tego materiału.'
                    : 'Ten materiał nie ma jeszcze kompendium.'}
                </span>
              </span>
            </label>
          </div>
        )}

        <DialogFooter>
          {running ? (
            <Button variant="destructive" onClick={handleStop}>
              <Square className="size-4" />
              Zatrzymaj
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Anuluj
              </Button>
              <Button
                onClick={() => void handleRun()}
                disabled={types.length === 0 || engine.status !== 'ready'}
              >
                {engine.status === 'ready' ? (
                  <Sparkles className="size-4" />
                ) : (
                  <Loader2 className="size-4 animate-spin" />
                )}
                Generuj
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
