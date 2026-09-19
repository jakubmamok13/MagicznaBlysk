import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  Keyboard,
  Layers,
  Quote,
  RotateCcw,
  Sparkles,
  Undo2,
  X,
} from 'lucide-react';

import { CardTypeBadge } from '@/components/card-type-badge';
import { ClozeText } from '@/components/cloze-text';
import { SourceModal } from '@/components/source-modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard';
import {
  closeSession,
  db,
  getDueCards,
  resumeOrCreateSession,
  updateSessionProgress,
  type Deck,
  type Flashcard,
} from '@/lib/db';
import {
  applyReview,
  formatInterval,
  previewInterval,
  RATING_OPTIONS,
  type CardSchedulingFields,
} from '@/lib/srs';
import { cn, errorMessage, pluralize } from '@/lib/utils';

/** Zapamiętany stan fiszki przed oceną — pozwala cofnąć ostatnią odpowiedź. */
interface ReviewSnapshot {
  card: Flashcard;
  previous: CardSchedulingFields;
  requeued: boolean;
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'ready'; deck: Deck; sessionId: number; queue: Flashcard[]; aheadMode: boolean };

const RATING_STYLES: Record<string, string> = {
  again: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  hard: 'bg-warning text-warning-foreground hover:bg-warning/90',
  good: 'bg-primary text-primary-foreground hover:bg-primary/90',
  easy: 'bg-success text-success-foreground hover:bg-success/90',
};

export function StudyPage(): React.JSX.Element {
  const params = useParams<{ deckId: string }>();
  const deckId = Number.parseInt(params.deckId ?? '', 10);
  const navigate = useNavigate();
  const { toast } = useToast();

  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [position, setPosition] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [history, setHistory] = useState<ReviewSnapshot[]>([]);
  const [showShortcuts, setShowShortcuts] = useState(false);

  /** Buduje kolejkę powtórek; `ahead` dobiera fiszki przed terminem. */
  const buildQueue = useCallback(
    async (ahead: boolean): Promise<void> => {
      if (!Number.isFinite(deckId)) {
        setState({ phase: 'missing' });
        return;
      }

      const deck = await db.decks.get(deckId);
      if (deck === undefined) {
        setState({ phase: 'missing' });
        return;
      }

      const due = await getDueCards(deckId);
      const queue =
        due.length > 0 || !ahead
          ? due
          : (await db.cards.where('deckId').equals(deckId).sortBy('dueDate')).slice(0, 20);

      const session = await resumeOrCreateSession(deckId);
      setState({ phase: 'ready', deck, sessionId: session.id, queue, aheadMode: ahead && due.length === 0 });
      setPosition(0);
      setRevealed(false);
      setHistory([]);
      setReviewed(session.totalReviewed);
    },
    [deckId],
  );

  useEffect(() => {
    void buildQueue(false);
  }, [buildQueue]);

  const current = state.phase === 'ready' ? (state.queue[position] ?? null) : null;
  const finished = state.phase === 'ready' && current === null;

  /** Zamknięcie sesji po wyczerpaniu kolejki. */
  useEffect(() => {
    if (!finished || state.phase !== 'ready') return;
    void closeSession(state.sessionId);
  }, [finished, state]);

  const handleRate = useCallback(
    async (quality: number): Promise<void> => {
      if (state.phase !== 'ready' || current === null) return;

      const scheduling = applyReview(current, quality);
      const snapshot: ReviewSnapshot = {
        card: current,
        previous: {
          interval: current.interval,
          repetitions: current.repetitions,
          easeFactor: current.easeFactor,
          dueDate: current.dueDate,
          leechCount: current.leechCount,
        },
        requeued: !scheduling.passed,
      };

      try {
        await db.cards.update(current.id, {
          interval: scheduling.interval,
          repetitions: scheduling.repetitions,
          easeFactor: scheduling.easeFactor,
          dueDate: scheduling.dueDate,
          leechCount: scheduling.leechCount,
        });

        const nextReviewed = reviewed + 1;
        setReviewed(nextReviewed);
        setHistory((items) => [...items.slice(-19), snapshot]);
        setRevealed(false);

        // Nieudana odpowiedź wraca na koniec dzisiejszej kolejki.
        setState((currentState) => {
          if (currentState.phase !== 'ready') return currentState;
          if (!scheduling.passed) {
            const updated: Flashcard = {
              ...current,
              interval: scheduling.interval,
              repetitions: scheduling.repetitions,
              easeFactor: scheduling.easeFactor,
              dueDate: scheduling.dueDate,
              leechCount: scheduling.leechCount,
            };
            return { ...currentState, queue: [...currentState.queue, updated] };
          }
          return currentState;
        });

        setPosition((value) => value + 1);
        await updateSessionProgress(state.sessionId, {
          currentCardIndex: position + 1,
          totalReviewed: nextReviewed,
        });
      } catch (error) {
        toast({ title: 'Nie udało się zapisać oceny', description: errorMessage(error), variant: 'error' });
      }
    },
    [current, position, reviewed, state, toast],
  );

  const handleUndo = useCallback(async (): Promise<void> => {
    const last = history[history.length - 1];
    if (last === undefined || state.phase !== 'ready') return;

    try {
      await db.cards.update(last.card.id, last.previous);
      setHistory((items) => items.slice(0, -1));
      setReviewed((value) => Math.max(0, value - 1));
      setRevealed(false);
      setPosition((value) => Math.max(0, value - 1));
      setState((currentState) => {
        if (currentState.phase !== 'ready' || !last.requeued) return currentState;
        // Usuwamy kopię dopiętą na koniec kolejki przy nieudanej odpowiedzi.
        const queue = [...currentState.queue];
        const lastIndex = queue.map((card) => card.id).lastIndexOf(last.card.id);
        if (lastIndex > 0) queue.splice(lastIndex, 1);
        return { ...currentState, queue };
      });
      await updateSessionProgress(state.sessionId, {
        currentCardIndex: Math.max(0, position - 1),
        totalReviewed: Math.max(0, reviewed - 1),
      });
    } catch (error) {
      toast({ title: 'Nie udało się cofnąć', description: errorMessage(error), variant: 'error' });
    }
  }, [history, position, reviewed, state, toast]);

  const exitStudy = useCallback((): void => {
    navigate('/dashboard');
  }, [navigate]);

  useKeyboardShortcuts(
    {
      ' ': () => {
        if (current !== null) setRevealed((value) => !value);
      },
      Enter: () => {
        if (current !== null) setRevealed((value) => !value);
      },
      '1': () => {
        if (revealed) void handleRate(RATING_OPTIONS[0]?.quality ?? 1);
      },
      '2': () => {
        if (revealed) void handleRate(RATING_OPTIONS[1]?.quality ?? 3);
      },
      '3': () => {
        if (revealed) void handleRate(RATING_OPTIONS[2]?.quality ?? 4);
      },
      '4': () => {
        if (revealed) void handleRate(RATING_OPTIONS[3]?.quality ?? 5);
      },
      s: () => {
        if (current !== null) setSourceOpen(true);
      },
      u: () => void handleUndo(),
      Escape: () => {
        // Escape najpierw domyka pomoc, a dopiero potem kończy sesję —
        // wyjście z nauki przy zamykaniu okna byłoby zaskakujące.
        if (showShortcuts) {
          setShowShortcuts(false);
          return;
        }
        exitStudy();
      },
      '?': () => setShowShortcuts((value) => !value),
    },
    // Przy otwartym oknie źródła skróty są wyłączone: Escape obsługuje wtedy
    // sam dialog, a cyfry nie mogą przypadkiem ocenić niewidocznej fiszki.
    state.phase === 'ready' && !sourceOpen,
  );

  if (state.phase === 'loading') {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (state.phase === 'missing') {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <Card className="max-w-sm">
          <CardContent className="space-y-3 py-8 text-center">
            <Layers className="mx-auto size-8 text-warning" />
            <h1 className="font-semibold">Nie znaleziono talii</h1>
            <Button asChild variant="outline">
              <Link to="/dashboard">
                <ArrowLeft className="size-4" />
                Wróć do panelu
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const total = state.queue.length;
  const percent = total === 0 ? 100 : Math.round((position / total) * 100);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-2.5">
          <Button variant="ghost" size="icon-sm" onClick={exitStudy} aria-label="Zakończ naukę">
            <X className="size-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium">{state.deck.name}</p>
            <Progress value={percent} className="mt-1 h-1.5" />
          </div>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {Math.min(position + (current === null ? 0 : 1), total)}/{total}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setShowShortcuts((value) => !value)}
            aria-label="Skróty klawiszowe"
          >
            <Keyboard className="size-4" />
          </Button>
        </div>
      </header>

      <main className="flex flex-1 items-start justify-center px-4 py-6 sm:items-center">
        <div className="w-full max-w-2xl space-y-5">
          {current === null ? (
            <SessionSummary
              reviewed={reviewed}
              aheadMode={state.aheadMode}
              onStudyAhead={() => void buildQueue(true)}
              onExit={exitStudy}
            />
          ) : (
            <>
              {state.aheadMode && (
                <p className="text-center text-xs text-muted-foreground">
                  Nauka przed terminem — te fiszki nie są jeszcze zaplanowane na dziś.
                </p>
              )}

              <ReviewCard card={current} revealed={revealed} onToggle={() => setRevealed((v) => !v)} />

              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setSourceOpen(true)}>
                  <Quote className="size-3.5" />
                  Sprawdź źródło
                  <kbd className="ml-1 hidden rounded border px-1 text-[10px] sm:inline">S</kbd>
                </Button>
                {history.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => void handleUndo()}>
                    <Undo2 className="size-3.5" />
                    Cofnij
                    <kbd className="ml-1 hidden rounded border px-1 text-[10px] sm:inline">U</kbd>
                  </Button>
                )}
              </div>

              {revealed ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {RATING_OPTIONS.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => void handleRate(option.quality)}
                      className={cn(
                        'flex flex-col items-center gap-0.5 rounded-lg px-3 py-3 text-sm font-medium shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                        RATING_STYLES[option.key],
                      )}
                    >
                      <span>{option.label}</span>
                      <span className="text-[11px] opacity-90">
                        {formatInterval(previewInterval(current, option.quality))}
                      </span>
                      <kbd className="mt-0.5 rounded bg-black/15 px-1 text-[10px]">
                        {option.shortcut}
                      </kbd>
                    </button>
                  ))}
                </div>
              ) : (
                <Button className="w-full" size="lg" onClick={() => setRevealed(true)}>
                  <Eye className="size-4" />
                  Pokaż odpowiedź
                  <kbd className="ml-1 rounded border border-white/30 px-1.5 text-[10px]">spacja</kbd>
                </Button>
              )}
            </>
          )}

          {showShortcuts && <ShortcutsHelp onClose={() => setShowShortcuts(false)} />}
        </div>
      </main>

      <SourceModal open={sourceOpen} onOpenChange={setSourceOpen} card={current} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

interface ReviewCardProps {
  card: Flashcard;
  revealed: boolean;
  onToggle: () => void;
}

/**
 * Fiszka w trybie nauki.
 * `basic`/`case` obracają się w 3D, `cloze` odsłania lukę w miejscu —
 * obrót zerwałby kontekst zdania.
 */
function ReviewCard({ card, revealed, onToggle }: ReviewCardProps): React.JSX.Element {
  if (card.type === 'cloze') {
    return (
      <Card className="min-h-[14rem]">
        <CardContent className="flex min-h-[14rem] flex-col justify-center gap-4 p-6 text-center">
          <div className="flex justify-center">
            <CardTypeBadge type={card.type} />
          </div>
          <ClozeText text={card.front} revealed={revealed} className="text-lg sm:text-xl" />
          {revealed && card.back.length > 0 && (
            <p className="border-t pt-3 text-sm text-muted-foreground animate-fade-in">{card.back}</p>
          )}
          <button
            type="button"
            onClick={onToggle}
            className="mx-auto text-xs text-muted-foreground underline underline-offset-4"
          >
            {revealed ? 'Ukryj lukę' : 'Odsłoń lukę'}
          </button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flip-scene">
      <div className="flip-card min-h-[16rem]" data-flipped={revealed}>
        {/* Awers */}
        <Card className="flip-face min-h-[16rem]">
          <CardContent className="flex min-h-[16rem] flex-col justify-center gap-4 p-6 text-center">
            <div className="flex justify-center">
              <CardTypeBadge type={card.type} />
            </div>
            <p className="text-balance text-lg font-medium leading-relaxed sm:text-xl">
              {card.front}
            </p>
            <button
              type="button"
              onClick={onToggle}
              className="mx-auto text-xs text-muted-foreground underline underline-offset-4"
            >
              Obróć fiszkę
            </button>
          </CardContent>
        </Card>

        {/* Rewers */}
        <Card className="flip-face flip-face-back min-h-[16rem] border-primary/40">
          <CardContent className="flex min-h-[16rem] flex-col justify-center gap-4 p-6 text-center">
            <Badge variant="success" className="mx-auto">
              Odpowiedź
            </Badge>
            <p className="text-balance text-lg font-medium leading-relaxed sm:text-xl">{card.back}</p>
            {card.explanation.length > 0 && (
              <p className="border-t pt-3 text-xs leading-relaxed text-muted-foreground">
                {card.explanation}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

interface SessionSummaryProps {
  reviewed: number;
  aheadMode: boolean;
  onStudyAhead: () => void;
  onExit: () => void;
}

function SessionSummary({
  reviewed,
  aheadMode,
  onStudyAhead,
  onExit,
}: SessionSummaryProps): React.JSX.Element {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
        <span className="grid size-14 place-items-center rounded-2xl bg-success/15 text-success">
          <CheckCircle2 className="size-7" />
        </span>
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Sesja zakończona</h1>
          <p className="text-sm text-muted-foreground">
            {reviewed > 0
              ? `Powtórzyłeś ${pluralize(reviewed, 'fiszkę', 'fiszki', 'fiszek')}. Kolejne terminy wyliczył algorytm SM-2.`
              : 'Nic nie czeka dziś na powtórkę w tej talii.'}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {!aheadMode && (
            <Button variant="outline" onClick={onStudyAhead}>
              <Sparkles className="size-4" />
              Ucz się przed terminem
            </Button>
          )}
          <Button onClick={onExit}>
            <ArrowLeft className="size-4" />
            Wróć do panelu
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ShortcutsHelp({ onClose }: { onClose: () => void }): React.JSX.Element {
  const rows = useMemo(
    () => [
      { keys: 'spacja / enter', action: 'pokaż lub ukryj odpowiedź' },
      { keys: '1', action: 'Znowu — nie pamiętam' },
      { keys: '2', action: 'Trudne' },
      { keys: '3', action: 'Dobre' },
      { keys: '4', action: 'Łatwe' },
      { keys: 'S', action: 'sprawdź cytat źródłowy' },
      { keys: 'U', action: 'cofnij ostatnią ocenę' },
      { keys: 'Esc', action: 'zakończ naukę' },
    ],
    [],
  );

  return (
    <Card className="animate-fade-in">
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Keyboard className="size-4" />
            Skróty klawiszowe
          </p>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Zamknij pomoc">
            <X className="size-3.5" />
          </Button>
        </div>
        <dl className="grid gap-1 text-xs sm:grid-cols-2">
          {rows.map((row) => (
            <div key={row.keys} className="flex items-center gap-2">
              <dt>
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                  {row.keys}
                </kbd>
              </dt>
              <dd className="text-muted-foreground">{row.action}</dd>
            </div>
          ))}
        </dl>
        <p className="flex items-center gap-1.5 pt-1 text-[11px] text-muted-foreground">
          <RotateCcw className="size-3" />
          Ocena „Znowu” wraca na koniec dzisiejszej kolejki.
        </p>
      </CardContent>
    </Card>
  );
}
