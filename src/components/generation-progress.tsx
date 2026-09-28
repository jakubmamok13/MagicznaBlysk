import { Check, ClipboardCopy, Loader2, Sparkles, Square, X } from 'lucide-react';
import { useState } from 'react';

import { CardTypeBadge } from '@/components/card-type-badge';
import { useEngine } from '@/hooks/use-engine';
import { copyToClipboard } from '@/lib/build-info';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { maskCloze } from '@/lib/cloze';
import { cn, pluralize, truncate } from '@/lib/utils';
import {
  formatEta,
  generationStore,
  jobPercent,
  type GenerationJob,
} from '@/services/ai/generation-store';
import { GENERATION_PHASES, PHASE_LABELS, type GenerationPhase } from '@/services/ai/generate';
import { buildGenerationReport } from '@/services/ai/report';

function phaseState(
  job: GenerationJob,
  phase: GenerationPhase,
): 'done' | 'active' | 'pending' {
  if (job.status === 'done') return 'done';
  const order = GENERATION_PHASES.indexOf(phase);
  const current = GENERATION_PHASES.indexOf(job.phase);
  if (current === -1) return 'pending';
  if (order < current) return 'done';
  if (order === current) return 'active';
  return 'pending';
}

/** Lista etapów — pokazuje, na czym dokładnie stoi proces. */
export function PhaseStepper({ job }: { job: GenerationJob }): React.JSX.Element {
  return (
    <ol className="space-y-1.5">
      {GENERATION_PHASES.map((phase) => {
        const state = phaseState(job, phase);
        return (
          <li
            key={phase}
            className={cn(
              'flex items-center gap-2 text-xs',
              state === 'active' && 'font-medium text-foreground',
              state === 'pending' && 'text-muted-foreground/60',
              state === 'done' && 'text-muted-foreground',
            )}
          >
            <span
              className={cn(
                'grid size-4 shrink-0 place-items-center rounded-full border',
                state === 'done' && 'border-success bg-success/15 text-success',
                state === 'active' && 'border-primary bg-primary/15 text-primary',
                state === 'pending' && 'border-border',
              )}
            >
              {state === 'done' && <Check className="size-2.5" />}
              {state === 'active' && <Loader2 className="size-2.5 animate-spin" />}
            </span>
            {PHASE_LABELS[phase]}
            {phase === 'generating' && job.chunkCount > 0 && state !== 'pending' && (
              <span className="tabular-nums text-muted-foreground">
                {job.chunkNumber}/{job.chunkCount}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Podgląd ostatnio utworzonych fiszek — widać, że model faktycznie pracuje. */
export function CardPreview({ job }: { job: GenerationJob }): React.JSX.Element | null {
  if (job.preview.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Sparkles className="size-3.5" />
        Ostatnio utworzone
      </p>
      <ul className="max-h-36 space-y-1 overflow-y-auto">
        {job.preview.map((card, index) => (
          <li
            key={`${card.front}-${index}`}
            className="flex items-start gap-2 rounded-md border bg-card/60 p-2 text-xs animate-fade-in"
          >
            <CardTypeBadge type={card.type} />
            <span className="min-w-0 flex-1 leading-snug">
              {truncate(card.type === 'cloze' ? maskCloze(card.front) : card.front, 110)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Przycisk kopiowania raportu z krótkim potwierdzeniem. */
function CopyReportButton({ job, className }: { job: GenerationJob; className?: string }): React.JSX.Element {
  const engine = useEngine();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('h-7 text-xs', className)}
      onClick={() => {
        void copyToClipboard(buildGenerationReport(job, engine)).then((ok) => {
          setCopied(ok);
          if (ok) setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? <Check className="size-3" /> : <ClipboardCopy className="size-3" />}
      {copied ? 'Skopiowano' : 'Kopiuj raport'}
    </Button>
  );
}

/** Pełny widok postępu — używany w oknie generowania. */
export function GenerationProgressPanel({ job }: { job: GenerationJob }): React.JSX.Element {
  const percent = jobPercent(job);
  const eta = formatEta(job.etaMs);
  // Raport przy każdym niepowodzeniu — także gdy nie udało się nawet wczytać modelu.
  const showReport = job.status === 'error' || (job.status !== 'running' && job.cardsAdded === 0);

  return (
    <div className="space-y-3" aria-live="polite">
      <Progress value={percent} indeterminate={job.phase === 'loading-model' && percent <= 4} />

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{job.message}</span>
        <span className="shrink-0 tabular-nums">
          {pluralize(job.cardsAdded, 'fiszka', 'fiszki', 'fiszek')}
          {eta !== null && ` · pozostało ${eta}`}
        </span>
      </div>

      <PhaseStepper job={job} />

      {job.outcomeNote !== null && (
        <p
          className={cn(
            'rounded-md p-2.5 text-xs',
            job.cardsAdded === 0
              ? 'bg-warning/10 text-warning'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {job.outcomeNote}
        </p>
      )}

      {job.error !== null && (
        <p className="rounded-md bg-destructive/10 p-2.5 text-xs text-destructive">{job.error}</p>
      )}

      {showReport && <CopyReportButton job={job} />}

      <CardPreview job={job} />

      {job.status === 'running' && (
        <p className="text-xs text-muted-foreground">
          Możesz zamknąć to okno — generowanie działa dalej, a fiszki zapisują się po każdym
          fragmencie.
        </p>
      )}
    </div>
  );
}

/**
 * Pasek w nagłówku aplikacji. Widoczny na każdym ekranie, dopóki trwa
 * generowanie — użytkownik nie musi siedzieć w oknie dialogowym.
 */
export function GenerationStrip({
  job,
  onOpen,
}: {
  job: GenerationJob;
  onOpen?: () => void;
}): React.JSX.Element | null {
  if (job.status === 'idle') return null;

  const percent = jobPercent(job);
  const eta = formatEta(job.etaMs);
  const finished = job.status !== 'running';

  return (
    <div
      className={cn(
        'border-b',
        job.status === 'error'
          ? 'border-destructive/30 bg-destructive/10'
          : finished
            ? 'border-success/30 bg-success/10'
            : 'border-primary/30 bg-primary/10',
      )}
    >
      <div className="container flex items-center gap-3 py-1.5">
        {job.status === 'running' ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : job.status === 'error' ? (
          <X className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <Check className="size-3.5 shrink-0 text-success" />
        )}

        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">
            {job.status === 'running' ? PHASE_LABELS[job.phase] : job.message}
            <span className="ml-1.5 font-normal text-muted-foreground">
              {truncate(job.documentTitle, 40)}
            </span>
          </p>
          {job.status === 'running' && <Progress value={percent} className="mt-1 h-1" />}
          {job.status === 'error' && job.error !== null && (
            <p className="mt-0.5 line-clamp-2 text-xs text-destructive">{job.error}</p>
          )}
        </div>

        <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
          {job.cardsAdded > 0 && `${job.cardsAdded} fiszek`}
          {eta !== null && job.status === 'running' && ` · ${eta}`}
        </span>

        {job.status === 'running' ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 text-xs"
            onClick={() => generationStore.cancel()}
          >
            <Square className="size-3" />
            <span className="hidden sm:inline">Zatrzymaj</span>
          </Button>
        ) : (
          <div className="flex shrink-0 gap-1">
            {(job.status === 'error' || job.cardsAdded === 0) && <CopyReportButton job={job} />}
            {onOpen !== undefined && (
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onOpen}>
                Pokaż
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => generationStore.dismiss()}
              aria-label="Ukryj pasek postępu"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
