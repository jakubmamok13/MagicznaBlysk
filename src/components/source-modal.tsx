import { Lightbulb, Quote } from 'lucide-react';

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
            Fragment materiału, z którego wprost wynika odpowiedź na tę fiszkę.
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
