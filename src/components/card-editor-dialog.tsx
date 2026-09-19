import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';

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
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { hasCloze, repairClozeSyntax } from '@/lib/cloze';
import { CARD_TYPES, db, toNewCard, type CardType, type Flashcard } from '@/lib/db';
import { CARD_TYPE_META } from '@/lib/labels';
import { errorMessage } from '@/lib/utils';

interface CardFormState {
  type: CardType;
  front: string;
  back: string;
  sourceExcerpt: string;
  explanation: string;
}

const EMPTY_FORM: CardFormState = {
  type: 'basic',
  front: '',
  back: '',
  sourceExcerpt: '',
  explanation: '',
};

export interface CardEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edytowana fiszka; `null` oznacza tworzenie nowej. */
  card: Flashcard | null;
  deckId: number;
}

/** Okno edycji/dodawania fiszki z walidacją składni luk. */
export function CardEditorDialog({
  open,
  onOpenChange,
  card,
  deckId,
}: CardEditorDialogProps): React.JSX.Element {
  const [form, setForm] = useState<CardFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (!open) return;
    setForm(
      card === null
        ? EMPTY_FORM
        : {
            type: card.type,
            front: card.front,
            back: card.back,
            sourceExcerpt: card.sourceExcerpt,
            explanation: card.explanation,
          },
    );
  }, [card, open]);

  const clozeInvalid = form.type === 'cloze' && !hasCloze(form.front);
  const incomplete = form.front.trim().length === 0 || form.back.trim().length === 0;

  const update = <K extends keyof CardFormState>(key: K, value: CardFormState[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleRepair = (): void => {
    const repaired = repairClozeSyntax(form.front);
    if (repaired === null) {
      toast({
        title: 'Nie znaleziono luki do naprawy',
        description: 'Otocz ukrywaną frazę składnią {{c1::fraza}}.',
        variant: 'error',
      });
      return;
    }
    update('front', repaired);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (incomplete || clozeInvalid || saving) return;

    setSaving(true);
    try {
      const payload = {
        type: form.type,
        front: form.front.trim(),
        back: form.back.trim(),
        sourceExcerpt: form.sourceExcerpt.trim(),
        explanation: form.explanation.trim(),
      };

      if (card === null) {
        await db.cards.add(toNewCard(deckId, payload));
        toast({ title: 'Fiszka dodana', variant: 'success' });
      } else {
        await db.cards.update(card.id, payload);
        toast({ title: 'Fiszka zapisana', variant: 'success' });
      }
      onOpenChange(false);
    } catch (error) {
      toast({ title: 'Nie udało się zapisać', description: errorMessage(error), variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{card === null ? 'Nowa fiszka' : 'Edycja fiszki'}</DialogTitle>
          <DialogDescription>{CARD_TYPE_META[form.type].description}</DialogDescription>
        </DialogHeader>

        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="card-type">Typ fiszki</Label>
            <Select value={form.type} onValueChange={(value) => update('type', value as CardType)}>
              <SelectTrigger id="card-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CARD_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {CARD_TYPE_META[type].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="card-front">
                {form.type === 'cloze' ? 'Zdanie z luką' : 'Awers (pytanie)'}
              </Label>
              {form.type === 'cloze' && clozeInvalid && (
                <Button type="button" variant="ghost" size="sm" onClick={handleRepair}>
                  Napraw składnię
                </Button>
              )}
            </div>
            <Textarea
              id="card-front"
              value={form.front}
              onChange={(event) => update('front', event.target.value)}
              placeholder={
                form.type === 'cloze'
                  ? 'Współczynnik łatwości nigdy nie spada poniżej {{c1::1,3}}.'
                  : 'Co określa współczynnik łatwości w SM-2?'
              }
              className="min-h-[80px]"
              required
            />
            {form.type === 'cloze' && clozeInvalid && (
              <p className="text-xs text-destructive">
                Fiszka z luką wymaga składni <code className="rounded bg-muted px-1">{'{{c1::fraza}}'}</code>.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="card-back">Rewers (odpowiedź)</Label>
            <Textarea
              id="card-back"
              value={form.back}
              onChange={(event) => update('back', event.target.value)}
              className="min-h-[72px]"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="card-source">Cytat źródłowy</Label>
            <Textarea
              id="card-source"
              value={form.sourceExcerpt}
              onChange={(event) => update('sourceExcerpt', event.target.value)}
              placeholder="Dosłowny fragment materiału potwierdzający odpowiedź."
              className="min-h-[64px] text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="card-explanation">Wyjaśnienie</Label>
            <Textarea
              id="card-explanation"
              value={form.explanation}
              onChange={(event) => update('explanation', event.target.value)}
              placeholder="Dlaczego ta odpowiedź jest poprawna?"
              className="min-h-[64px] text-xs"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Anuluj
            </Button>
            <Button type="submit" disabled={incomplete || clozeInvalid || saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              Zapisz
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
