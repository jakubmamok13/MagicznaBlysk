import { useCallback, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  ArrowLeft,
  BookOpenText,
  FileText,
  Filter,
  Pencil,
  Play,
  Plus,
  Quote,
  Search,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';

import { CardEditorDialog } from '@/components/card-editor-dialog';
import { CardTypeBadge } from '@/components/card-type-badge';
import { EnginePanel } from '@/components/engine-panel';
import { GenerateCardsDialog } from '@/components/generate-cards-dialog';
import { Markdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { maskCloze } from '@/lib/cloze';
import { db, type Deck, type Flashcard, type StudyDocument } from '@/lib/db';
import { CARD_TYPE_META } from '@/lib/labels';
import { formatInterval, isLeech } from '@/lib/srs';
import { countWords, readingTimeMinutes } from '@/lib/text';
import { cn, errorMessage, formatDate, pluralize, truncate } from '@/lib/utils';

type StatusFilter = 'all' | 'due' | 'fresh' | 'learning' | 'leech';
type TypeFilter = 'all' | Flashcard['type'];

interface WorkspaceData {
  document: StudyDocument | undefined;
  deck: Deck | undefined;
  cards: Flashcard[];
}

export function DocumentWorkspacePage(): React.JSX.Element {
  const params = useParams<{ documentId: string }>();
  const documentId = Number.parseInt(params.documentId ?? '', 10);

  const data = useLiveQuery(
    async (): Promise<WorkspaceData> => {
      if (!Number.isFinite(documentId)) return { document: undefined, deck: undefined, cards: [] };
      const document = await db.documents.get(documentId);
      const deck = await db.decks.where('documentId').equals(documentId).first();
      const cards =
        deck === undefined
          ? []
          : await db.cards.where('deckId').equals(deck.id).reverse().sortBy('createdAt');
      return { document, deck, cards };
    },
    [documentId],
  );

  if (data === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-[60dvh]" />
          <Skeleton className="h-[60dvh]" />
        </div>
      </div>
    );
  }

  if (data.document === undefined || data.deck === undefined) {
    return (
      <Card className="mx-auto max-w-md">
        <CardContent className="space-y-3 py-8 text-center">
          <AlertTriangle className="mx-auto size-8 text-warning" />
          <h1 className="font-semibold">Nie znaleziono materiału</h1>
          <p className="text-sm text-muted-foreground">
            Materiał mógł zostać usunięty z tego urządzenia.
          </p>
          <Button asChild variant="outline">
            <Link to="/dashboard">
              <ArrowLeft className="size-4" />
              Wróć do panelu
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return <Workspace document={data.document} deck={data.deck} cards={data.cards} />;
}

/* -------------------------------------------------------------------------- */

interface WorkspaceProps {
  document: StudyDocument;
  deck: Deck;
  cards: Flashcard[];
}

function Workspace({ document, deck, cards }: WorkspaceProps): React.JSX.Element {
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [generateOpen, setGenerateOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editedCard, setEditedCard] = useState<Flashcard | null>(null);

  const dueCount = useMemo(() => {
    const now = Date.now();
    return cards.filter((card) => card.dueDate.getTime() <= now).length;
  }, [cards]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('pl-PL');
    const now = Date.now();

    return cards.filter((card) => {
      if (typeFilter !== 'all' && card.type !== typeFilter) return false;

      switch (statusFilter) {
        case 'due':
          if (card.dueDate.getTime() > now) return false;
          break;
        case 'fresh':
          if (card.repetitions > 0) return false;
          break;
        case 'learning':
          if (card.repetitions === 0 || card.interval >= 21) return false;
          break;
        case 'leech':
          if (!isLeech(card)) return false;
          break;
        default:
          break;
      }

      if (query.length === 0) return true;
      return [card.front, card.back, card.sourceExcerpt, card.explanation]
        .join(' ')
        .toLocaleLowerCase('pl-PL')
        .includes(query);
    });
  }, [cards, search, statusFilter, typeFilter]);

  const openEditor = useCallback((card: Flashcard | null): void => {
    setEditedCard(card);
    setEditorOpen(true);
  }, []);

  const handleDelete = useCallback(
    async (card: Flashcard): Promise<void> => {
      if (!window.confirm('Usunąć tę fiszkę? Operacji nie można cofnąć.')) return;
      try {
        await db.cards.delete(card.id);
        toast({ title: 'Fiszka usunięta', variant: 'success' });
      } catch (error) {
        toast({ title: 'Nie udało się usunąć', description: errorMessage(error), variant: 'error' });
      }
    },
    [toast],
  );

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Button asChild variant="ghost" size="sm" className="-ml-2 mb-1 text-muted-foreground">
            <Link to="/dashboard">
              <ArrowLeft className="size-4" />
              Panel
            </Link>
          </Button>
          <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">
            {document.title}
          </h1>
          <p className="text-xs text-muted-foreground">
            {pluralize(countWords(document.rawContent), 'słowo', 'słowa', 'słów')} · ok.{' '}
            {readingTimeMinutes(document.rawContent)} min czytania · dodano{' '}
            {formatDate(document.createdAt)}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setGenerateOpen(true)}>
            <Wand2 className="size-4" />
            Generuj fiszki
          </Button>
          <Button variant="outline" onClick={() => openEditor(null)}>
            <Plus className="size-4" />
            Dodaj ręcznie
          </Button>
          {dueCount > 0 && (
            <Button asChild variant="secondary">
              <Link to={`/study/${deck.id}`}>
                <Play className="size-4" />
                Ucz się ({dueCount})
              </Link>
            </Button>
          )}
        </div>
      </header>

      {/* Podział roboczy: źródło po lewej, wygenerowane fiszki po prawej. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex min-h-[40dvh] flex-col lg:max-h-[calc(100dvh-13rem)]">
          <Tabs defaultValue="source" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="self-start">
              <TabsTrigger value="source">
                <FileText className="size-3.5" />
                Materiał źródłowy
              </TabsTrigger>
              <TabsTrigger value="summary">
                <BookOpenText className="size-3.5" />
                Kompendium
              </TabsTrigger>
            </TabsList>

            <TabsContent value="source" className="min-h-0 flex-1">
              <Card className="h-full">
                <CardContent className="h-full overflow-y-auto p-4">
                  <Markdown>{document.rawContent}</Markdown>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="summary" className="min-h-0 flex-1">
              <Card className="h-full">
                <CardContent className="h-full overflow-y-auto p-4">
                  {document.structuredSummary.length > 0 ? (
                    <Markdown>{document.structuredSummary}</Markdown>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-3 py-10 text-center">
                      <Sparkles className="size-8 text-muted-foreground" />
                      <p className="max-w-xs text-sm text-muted-foreground">
                        Kompendium powstanie razem z pierwszym generowaniem fiszek.
                      </p>
                      <Button size="sm" variant="outline" onClick={() => setGenerateOpen(true)}>
                        <Wand2 className="size-4" />
                        Uruchom generowanie
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </section>

        <section className="flex min-h-0 flex-col gap-3 lg:max-h-[calc(100dvh-13rem)]">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">
                Fiszki
                <span className="ml-2 font-normal text-muted-foreground">
                  {filtered.length === cards.length
                    ? pluralize(cards.length, 'fiszka', 'fiszki', 'fiszek')
                    : `${filtered.length} z ${cards.length}`}
                </span>
              </h2>
              {dueCount > 0 && <Badge variant="warning">{dueCount} do powtórki</Badge>}
            </div>

            <div className="flex flex-wrap gap-2">
              <div className="relative min-w-[10rem] flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Szukaj w fiszkach…"
                  className="pl-8"
                  aria-label="Szukaj w fiszkach"
                />
              </div>
              <Select value={typeFilter} onValueChange={(value) => setTypeFilter(value as TypeFilter)}>
                <SelectTrigger className="h-10 w-auto min-w-[8rem] gap-1.5" aria-label="Filtr typu">
                  <Filter className="size-3.5 opacity-60" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Wszystkie typy</SelectItem>
                  <SelectItem value="basic">{CARD_TYPE_META.basic.short}</SelectItem>
                  <SelectItem value="cloze">{CARD_TYPE_META.cloze.short}</SelectItem>
                  <SelectItem value="case">{CARD_TYPE_META.case.short}</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={statusFilter}
                onValueChange={(value) => setStatusFilter(value as StatusFilter)}
              >
                <SelectTrigger className="h-10 w-auto min-w-[8rem]" aria-label="Filtr statusu">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Wszystkie statusy</SelectItem>
                  <SelectItem value="due">Do powtórki</SelectItem>
                  <SelectItem value="fresh">Nowe</SelectItem>
                  <SelectItem value="learning">W nauce</SelectItem>
                  <SelectItem value="leech">Problematyczne</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
            {cards.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                  <Sparkles className="size-8 text-muted-foreground" />
                  <p className="max-w-xs text-sm text-muted-foreground">
                    Brak fiszek. Uruchom lokalny model, aby rozłożyć materiał na atomowe pytania.
                  </p>
                  <Button onClick={() => setGenerateOpen(true)}>
                    <Wand2 className="size-4" />
                    Generuj fiszki
                  </Button>
                </CardContent>
              </Card>
            ) : filtered.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  Żadna fiszka nie spełnia wybranych filtrów.
                </CardContent>
              </Card>
            ) : (
              filtered.map((card) => (
                <CardRow
                  key={card.id}
                  card={card}
                  onEdit={() => openEditor(card)}
                  onDelete={() => void handleDelete(card)}
                />
              ))
            )}
          </div>

          <EnginePanel variant="compact" className="lg:hidden" />
        </section>
      </div>

      <GenerateCardsDialog
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        document={document}
        deckId={deck.id}
        hasSummary={document.structuredSummary.length > 0}
      />
      <CardEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        card={editedCard}
        deckId={deck.id}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

interface CardRowProps {
  card: Flashcard;
  onEdit: () => void;
  onDelete: () => void;
}

function CardRow({ card, onEdit, onDelete }: CardRowProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const isDue = card.dueDate.getTime() <= Date.now();
  const front = card.type === 'cloze' ? maskCloze(card.front) : card.front;

  return (
    <Card className={cn('transition-colors', isDue && 'border-warning/40')}>
      <CardContent className="space-y-2 p-3">
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="min-w-0 flex-1 text-left"
            aria-expanded={expanded}
          >
            <p className="text-sm font-medium leading-snug">{front}</p>
            {!expanded && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {truncate(card.back, 90)}
              </p>
            )}
          </button>
          <div className="flex shrink-0 gap-1">
            <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label="Edytuj fiszkę">
              <Pencil className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label="Usuń fiszkę">
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>

        {expanded && (
          <div className="space-y-2 border-t pt-2 animate-fade-in">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Odpowiedź
              </p>
              <p className="text-sm leading-relaxed">{card.back}</p>
            </div>
            {card.sourceExcerpt.length > 0 && (
              <div>
                <p className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Quote className="size-3" />
                  Cytat źródłowy
                </p>
                <blockquote className="border-l-2 border-primary/50 pl-2 text-xs italic text-muted-foreground">
                  {card.sourceExcerpt}
                </blockquote>
              </div>
            )}
            {card.explanation.length > 0 && (
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Wyjaśnienie
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">{card.explanation}</p>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <CardTypeBadge type={card.type} />
          <span>
            {isDue ? 'do powtórki teraz' : `powtórka ${formatDate(card.dueDate)}`}
          </span>
          <span>odstęp {formatInterval(card.interval)}</span>
          <span>EF {card.easeFactor.toFixed(2)}</span>
          {isLeech(card) && <span className="text-destructive">problematyczna</span>}
        </div>
      </CardContent>
    </Card>
  );
}
