import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { crashCount, getStartupCrash } from '@/lib/crash-guard';
import { modelLabel } from '@/lib/models';

/**
 * Baner po ubiciu strony w trakcie generowania. iOS zamyka kartę bez żadnego
 * błędu, gdy modelowi zabraknie pamięci — to jedyne miejsce, w którym możemy
 * powiedzieć użytkownikowi, co się stało i co zrobić dalej.
 */
export function CrashNotice(): React.JSX.Element | null {
  const [crash, setCrash] = useState(getStartupCrash);
  if (crash === null) return null;

  const times = crashCount(crash.modelId);

  return (
    <div role="alert" className="border-b border-warning/40 bg-warning/10">
      <div className="container flex gap-3 py-3 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="font-medium">System zamknął aplikację podczas generowania fiszek</p>
          <p className="text-muted-foreground">
            Model {modelLabel(crash.modelId)} potrzebował więcej pamięci, niż przeglądarka na tym
            urządzeniu pozwala jednej karcie
            {times > 1 ? ` (to już ${times}. taka sytuacja)` : ''}. Fiszki zapisane przed
            zamknięciem są w talii. Na iPhonie lokalny model AI często przekracza ten limit —
            najpewniejsza droga: wygeneruj fiszki na komputerze i przenieś je przez{' '}
            <Link to="/settings" className="font-medium text-foreground underline">
              Ustawienia → Eksportuj dane / Importuj kopię
            </Link>
            . Nauka na telefonie działa normalnie.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zamknij komunikat"
          onClick={() => setCrash(null)}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
