import { useCallback, useState } from 'react';
import { Download, Sparkles, Square, Wand2 } from 'lucide-react';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { GenerationProgressPanel } from '@/components/generation-progress';
import { useEngine } from '@/hooks/use-engine';
import { useGeneration } from '@/hooks/use-generation';
import { CARD_TYPES, type CardType, type StudyDocument } from '@/lib/db';
import { CARD_TYPE_META } from '@/lib/labels';
import { chunkText } from '@/lib/text';
import { cn, errorMessage, pluralize } from '@/lib/utils';
import { generationStore } from '@/services/ai/generation-store';

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
  const job = useGeneration();

  const chunkCount = chunkText(document.rawContent).length;
  // Postęp dotyczy tego dokumentu tylko wtedy, gdy zadanie jest właśnie jego.
  const running = job.status === 'running' && job.documentId === document.id;
  const finishedHere = job.status !== 'idle' && job.status !== 'running' && job.documentId === document.id;

  const toggleType = useCallback((type: CardType): void => {
    setTypes((current) =>
      current.includes(type) ? current.filter((item) => item !== type) : [...current, type],
    );
  }, []);

  /**
   * Zadanie żyje w store poza Reactem — okno można zamknąć, a proces trwa
   * dalej i pokazuje się w pasku nagłówka.
   */
  const handleRun = useCallback((): void => {
    void generationStore
      .start({ document, deckId, allowedTypes: types, cardsPerChunk, regenerateSummary })
      .catch((error: unknown) => {
        toast({
          title: 'Generowanie nie powiodło się',
          description: errorMessage(error),
          variant: 'error',
        });
      });
    // Zamykamy okno od razu — dalszy postęp widać w pasku u góry.
    onOpenChange(false);
  }, [cardsPerChunk, deckId, document, onOpenChange, regenerateSummary, toast, types]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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

        {running || finishedHere ? (
          <GenerationProgressPanel job={job} />
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
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Ukryj okno
              </Button>
              <Button variant="destructive" onClick={() => generationStore.cancel()}>
                <Square className="size-4" />
                Zatrzymaj
              </Button>
            </>
          ) : finishedHere ? (
            <Button
              onClick={() => {
                generationStore.dismiss();
                onOpenChange(false);
              }}
            >
              Zamknij
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Anuluj
              </Button>
              <Button
                onClick={handleRun}
                disabled={types.length === 0 || engine.status === 'unsupported'}
              >
                {engine.status === 'ready' ? (
                  <Sparkles className="size-4" />
                ) : (
                  <Download className="size-4" />
                )}
                {engine.status === 'ready' ? 'Generuj' : 'Uruchom model i generuj'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
