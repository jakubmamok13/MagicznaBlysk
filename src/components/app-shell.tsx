import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { BrainCircuit, LayoutDashboard, Settings, WifiOff } from 'lucide-react';

import { EngineStatusBadge } from '@/components/engine-panel';
import { GenerationStrip } from '@/components/generation-progress';
import { PwaUpdatePrompt } from '@/components/pwa-update';
import { Badge } from '@/components/ui/badge';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useEngine } from '@/hooks/use-engine';
import { useGeneration } from '@/hooks/use-generation';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { useToast } from '@/components/ui/toast';
import { countDueCards } from '@/lib/db';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Panel', icon: LayoutDashboard },
  { to: '/settings', label: 'Ustawienia', icon: Settings },
] as const;

/**
 * Powłoka aplikacji: nagłówek z nawigacją, stanem silnika AI i licznikiem
 * powtórek. W widoku nauki nagłówek jest ukryty (tryb bez rozproszeń).
 */
export function AppShell(): React.JSX.Element {
  const engine = useEngine();
  const generation = useGeneration();
  const online = useOnlineStatus();
  const navigate = useNavigate();
  const location = useLocation();
  const dueToday = useLiveQuery(() => countDueCards(), [], 0);
  const isStudyMode = location.pathname.startsWith('/study/');
  const { toast } = useToast();

  /** Jedno powiadomienie po zakończeniu generowania, gdziekolwiek jest użytkownik. */
  const notifiedStatus = useRef<string>('idle');
  useEffect(() => {
    if (generation.status === notifiedStatus.current) return;
    notifiedStatus.current = generation.status;

    if (generation.status === 'done') {
      toast({
        title:
          generation.cardsAdded > 0
            ? `Gotowe — ${generation.cardsAdded} nowych fiszek`
            : 'Zakończono, ale nie powstała żadna fiszka',
        ...(generation.outcomeNote !== null ? { description: generation.outcomeNote } : {}),
        variant: generation.cardsAdded > 0 ? 'success' : 'error',
        duration: generation.cardsAdded > 0 ? 4500 : 12000,
      });
    } else if (generation.status === 'error') {
      toast({
        title: 'Generowanie nie powiodło się',
        description: generation.error ?? undefined,
        variant: 'error',
      });
    }
  }, [generation, toast]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-dvh flex-col bg-background">
        <PwaUpdatePrompt />

        {/* Postęp generowania widoczny niezależnie od otwartego widoku. */}
        <GenerationStrip
          job={generation}
          onOpen={() => navigate(`/documents/${generation.documentId}`)}
        />

        {!isStudyMode && (
          <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
            <div className="container flex h-14 items-center justify-between gap-3">
              <NavLink to="/dashboard" className="flex items-center gap-2 font-semibold">
                <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
                  <BrainCircuit className="size-4" />
                </span>
                <span className="hidden sm:inline">CognitiveDeck</span>
              </NavLink>

              <nav className="flex items-center gap-1" aria-label="Nawigacja główna">
                {NAV_ITEMS.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-accent text-accent-foreground'
                          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                      )
                    }
                  >
                    <item.icon className="size-4" />
                    <span className="hidden sm:inline">{item.label}</span>
                  </NavLink>
                ))}
              </nav>

              <div className="flex items-center gap-2">
                {!online && (
                  <Badge variant="outline" title="Brak sieci — aplikacja działa offline">
                    <WifiOff className="size-3" />
                    <span className="hidden sm:inline">offline</span>
                  </Badge>
                )}
                {dueToday > 0 && (
                  <Badge variant="warning" title="Fiszki gotowe do powtórki">
                    {dueToday} do powtórki
                  </Badge>
                )}
                <span className="hidden md:inline">
                  <EngineStatusBadge state={engine} />
                </span>
              </div>
            </div>
          </header>
        )}

        <main className={cn('flex-1', !isStudyMode && 'container py-5 sm:py-7')}>
          <Outlet />
        </main>

        {!isStudyMode && (
          <footer className="border-t py-4">
            <p className="container text-center text-xs text-muted-foreground">
              CognitiveDeck — wszystkie materiały, fiszki i model AI pozostają na Twoim urządzeniu.
            </p>
          </footer>
        )}
      </div>
    </TooltipProvider>
  );
}
