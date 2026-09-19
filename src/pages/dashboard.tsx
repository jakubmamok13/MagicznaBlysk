import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  BookOpenText,
  CalendarClock,
  FileText,
  Flame,
  GraduationCap,
  Layers,
  Play,
  Sparkles,
  Trash2,
  TrendingUp,
} from 'lucide-react';

import { EnginePanel } from '@/components/engine-panel';
import { ImportDocumentDialog } from '@/components/import-document-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { createDocumentWithDeck, deleteDocumentCascade } from '@/lib/db';
import { SAMPLE_DOCUMENT_CONTENT, SAMPLE_DOCUMENT_TITLE } from '@/lib/sample';
import { getDashboardSnapshot, getForecast, type DeckSummary } from '@/lib/stats';
import { errorMessage, formatDate, pluralize } from '@/lib/utils';

export function DashboardPage(): React.JSX.Element {
  const snapshot = useLiveQuery(() => getDashboardSnapshot(), [], undefined);
  const forecast = useLiveQuery(() => getForecast(7), [], undefined);
  const { toast } = useToast();

  const addSample = useCallback(async (): Promise<void> => {
    try {
      await createDocumentWithDeck({
        title: SAMPLE_DOCUMENT_TITLE,
        rawContent: SAMPLE_DOCUMENT_CONTENT,
      });
      toast({
        title: 'Dodano przykładowy materiał',
        description: 'Otwórz go i wygeneruj fiszki, aby zobaczyć cały przepływ pracy.',
        variant: 'success',
      });
    } catch (error) {
      toast({ title: 'Nie udało się dodać przykładu', description: errorMessage(error), variant: 'error' });
    }
  }, [toast]);

  if (snapshot === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-48" />
      </div>
    );
  }

  const { totals, decks, documents } = snapshot;
  const hasContent = documents.length > 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Panel nauki</h1>
          <p className="text-sm text-muted-foreground">
            {totals.cards === 0
              ? 'Dodaj pierwszy materiał, aby zbudować z niego kompendium i fiszki.'
              : totals.due > 0
                ? `Masz ${pluralize(totals.due, 'fiszkę', 'fiszki', 'fiszek')} gotowe do powtórki.`
                : 'Brak zaległych powtórek — wszystko na dziś zrobione.'}
          </p>
        </div>
        <ImportDocumentDialog />
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={<Flame className="size-4" />}
          label="Do powtórki teraz"
          value={totals.due}
          tone={totals.due > 0 ? 'warning' : 'success'}
        />
        <StatTile icon={<Layers className="size-4" />} label="Wszystkie fiszki" value={totals.cards} />
        <StatTile
          icon={<TrendingUp className="size-4" />}
          label="Utrwalone (≥ 21 dni)"
          value={totals.mature}
        />
        <StatTile
          icon={<GraduationCap className="size-4" />}
          label="Powtórzone dziś"
          value={totals.reviewedToday}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                <Layers className="size-4 text-primary" />
                Twoje talie
              </h2>
              {decks.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {pluralize(decks.length, 'talia', 'talie', 'talii')}
                </span>
              )}
            </div>

            {!hasContent ? (
              <EmptyState onAddSample={() => void addSample()} />
            ) : decks.length === 0 ? (
              <Card>
                <CardContent className="py-6 text-center text-sm text-muted-foreground">
                  Nie masz jeszcze żadnej talii.
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {decks.map((summary) => (
                  <DeckCard key={summary.deck.id} summary={summary} />
                ))}
              </div>
            )}
          </section>

          {hasContent && (
            <section className="space-y-3">
              <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                <FileText className="size-4 text-primary" />
                Materiały źródłowe
              </h2>
              <Card>
                <CardContent className="divide-y p-0">
                  {documents.map((document) => (
                    <DocumentRow
                      key={document.id}
                      documentId={document.id}
                      title={document.title}
                      createdAt={document.createdAt}
                      hasSummary={document.structuredSummary.length > 0}
                    />
                  ))}
                </CardContent>
              </Card>
            </section>
          )}
        </div>

        <div className="space-y-4">
          <EnginePanel />

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <CalendarClock className="size-4 text-primary" />
                Prognoza 7 dni
              </CardTitle>
              <CardDescription>Rozkład zaplanowanych powtórek.</CardDescription>
            </CardHeader>
            <CardContent>
              {forecast === undefined ? (
                <Skeleton className="h-24" />
              ) : (
                <Forecast days={forecast} />
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

interface StatTileProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: 'default' | 'warning' | 'success';
}

function StatTile({ icon, label, value, tone = 'default' }: StatTileProps): React.JSX.Element {
  const toneClass =
    tone === 'warning' ? 'text-warning' : tone === 'success' ? 'text-success' : 'text-primary';
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <span className={`grid size-9 shrink-0 place-items-center rounded-lg bg-muted ${toneClass}`}>
          {icon}
        </span>
        <span className="min-w-0">
          <span className="block text-2xl font-semibold leading-none tabular-nums">{value}</span>
          <span className="block truncate text-xs text-muted-foreground">{label}</span>
        </span>
      </CardContent>
    </Card>
  );
}

function DeckCard({ summary }: { summary: DeckSummary }): React.JSX.Element {
  const progress = summary.total === 0 ? 0 : Math.round((summary.mature / summary.total) * 100);

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">{summary.deck.name}</CardTitle>
          {summary.due > 0 ? (
            <Badge variant="warning">{summary.due} do powtórki</Badge>
          ) : summary.total > 0 ? (
            <Badge variant="success">na dziś gotowe</Badge>
          ) : (
            <Badge variant="outline">pusta</Badge>
          )}
        </div>
        {summary.deck.name !== summary.documentTitle && (
          <CardDescription className="truncate">{summary.documentTitle}</CardDescription>
        )}
      </CardHeader>

      <CardContent className="mt-auto space-y-3">
        <div className="space-y-1.5">
          <Progress value={progress} />
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{summary.total} łącznie</span>
            <span>{summary.fresh} nowych</span>
            <span>{summary.mature} utrwalonych</span>
            {summary.leeches > 0 && (
              <span className="text-destructive">{summary.leeches} problematycznych</span>
            )}
          </div>
          {summary.due === 0 && summary.nextDueAt !== null && (
            <p className="text-xs text-muted-foreground">
              Następna powtórka: {formatDate(summary.nextDueAt)}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant={summary.due > 0 ? 'default' : 'secondary'}>
            <Link to={`/study/${summary.deck.id}`}>
              <Play className="size-3.5" />
              {summary.due > 0 ? 'Ucz się' : 'Przejrzyj'}
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to={`/documents/${summary.documentId}`}>
              <BookOpenText className="size-3.5" />
              Materiał
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface DocumentRowProps {
  documentId: number;
  title: string;
  createdAt: Date;
  hasSummary: boolean;
}

function DocumentRow({
  documentId,
  title,
  createdAt,
  hasSummary,
}: DocumentRowProps): React.JSX.Element {
  const { toast } = useToast();

  const handleDelete = useCallback(async (): Promise<void> => {
    const confirmed = window.confirm(
      `Usunąć materiał „${title}” wraz ze wszystkimi fiszkami? Tej operacji nie można cofnąć.`,
    );
    if (!confirmed) return;
    try {
      await deleteDocumentCascade(documentId);
      toast({ title: 'Materiał usunięty', variant: 'success' });
    } catch (error) {
      toast({ title: 'Nie udało się usunąć', description: errorMessage(error), variant: 'error' });
    }
  }, [documentId, title, toast]);

  return (
    <div className="flex items-center gap-3 p-3">
      <Link to={`/documents/${documentId}`} className="min-w-0 flex-1 hover:underline">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">
          dodano {formatDate(createdAt)}
          {hasSummary ? ' · kompendium gotowe' : ' · bez kompendium'}
        </span>
      </Link>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => void handleDelete()}
        aria-label={`Usuń materiał ${title}`}
      >
        <Trash2 className="size-4 text-muted-foreground" />
      </Button>
    </div>
  );
}

function Forecast({ days }: { days: { label: string; count: number }[] }): React.JSX.Element {
  const max = Math.max(1, ...days.map((day) => day.count));

  return (
    <div className="flex h-28 items-end justify-between gap-1.5">
      {days.map((day, index) => (
        <div key={`${day.label}-${index}`} className="flex flex-1 flex-col items-center gap-1.5">
          <span className="text-[10px] tabular-nums text-muted-foreground">{day.count}</span>
          <div
            className={`w-full rounded-t ${index === 0 ? 'bg-warning' : 'bg-primary/70'}`}
            style={{ height: `${Math.max(4, (day.count / max) * 72)}px` }}
            role="presentation"
          />
          <span className="text-[10px] text-muted-foreground">{day.label}</span>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ onAddSample }: { onAddSample: () => void }): React.JSX.Element {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
        <span className="grid size-12 place-items-center rounded-xl bg-primary/10 text-primary">
          <Sparkles className="size-6" />
        </span>
        <div className="space-y-1">
          <h3 className="font-semibold">Zacznij od materiału</h3>
          <p className="max-w-md text-sm text-muted-foreground">
            Wklej notatki lub rozdział podręcznika. Lokalny model zbuduje z nich kompendium i zestaw
            atomowych fiszek — bez wysyłania czegokolwiek do internetu.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <ImportDocumentDialog />
          <Button variant="outline" onClick={onAddSample}>
            <Sparkles className="size-4" />
            Wypróbuj na przykładzie
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
