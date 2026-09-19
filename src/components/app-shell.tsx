import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { BrainCircuit, LayoutDashboard, Settings, WifiOff } from 'lucide-react';

import { EngineStatusBadge } from '@/components/engine-panel';
import { PwaUpdatePrompt } from '@/components/pwa-update';
import { Badge } from '@/components/ui/badge';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useEngine } from '@/hooks/use-engine';
import { useOnlineStatus } from '@/hooks/use-online-status';
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
  const online = useOnlineStatus();
  const location = useLocation();
  const dueToday = useLiveQuery(() => countDueCards(), [], 0);
  const isStudyMode = location.pathname.startsWith('/study/');

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-dvh flex-col bg-background">
        <PwaUpdatePrompt />

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
