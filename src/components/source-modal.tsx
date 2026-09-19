import { AlertTriangle, Lightbulb, Quote } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Flashcard } from '@/lib/db';

export interface SourceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  card: Flashcard | null;
}

/** Modal „Sprawdź źródło” — cytat potwierdzający odpowiedź oraz wyjaśnienie. */
export function SourceModal({ open, onOpenChange, card }: SourceModalProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Quote className="size-4 text-primary" />
            Źródło odpowiedzi
          </DialogTitle>
          <DialogDescription>
            {card?.verified === false
              ? 'Cytat podany przez model — nie udało się go potwierdzić w materiale.'
              : 'Fragment materiału, z którego wprost wynika odpowiedź na tę fiszkę.'}
          </DialogDescription>
        </DialogHeader>

        {card === null ? (
          <p className="text-sm text-muted-foreground">Brak danych fiszki.</p>
        ) : (
          <div className="space-y-4">
            <blockquote className="border-l-2 border-primary/60 bg-muted/50 py-2 pl-4 pr-2 text-sm italic leading-relaxed">
              {card.sourceExcerpt.length > 0
                ? card.sourceExcerpt
                : 'Ta fiszka nie ma zapisanego cytatu źródłowego (dodana ręcznie).'}
            </blockquote>

            {card.verified === false && (
              <p className="flex items-start gap-2 rounded-md bg-warning/10 p-2.5 text-xs text-warning">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                Tego cytatu nie udało się odnaleźć w materiale dosłownie — model podał własne
                sformułowanie. Zweryfikuj je przed nauką.
              </p>
            )}

            {card.explanation.length > 0 && (
              <div className="space-y-1.5">
                <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <Lightbulb className="size-3.5" />
                  Wyjaśnienie
                </p>
                <p className="text-sm leading-relaxed">{card.explanation}</p>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
