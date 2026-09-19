import { useRegisterSW } from 'virtual:pwa-register/react';
import { Download, RefreshCw, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

/**
 * Pasek aktualizacji PWA oraz wskaźnik pracy offline.
 * `registerType: 'prompt'` — nigdy nie przeładowujemy aplikacji w trakcie nauki
 * bez zgody użytkownika.
 */
export function PwaUpdatePrompt(): React.JSX.Element | null {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  const [dismissedOffline, setDismissedOffline] = useState(false);

  useEffect(() => {
    if (!offlineReady) return;
    const timer = window.setTimeout(() => {
      setDismissedOffline(true);
      setOfflineReady(false);
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [offlineReady, setOfflineReady]);

  if (needRefresh) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2 text-xs">
        <span className="flex items-center gap-2 font-medium">
          <Download className="size-3.5" />
          Dostępna jest nowa wersja aplikacji.
        </span>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void updateServiceWorker(true)}>
            <RefreshCw className="size-3.5" />
            Odśwież
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNeedRefresh(false)}>
            Później
          </Button>
        </div>
      </div>
    );
  }

  if (offlineReady && !dismissedOffline) {
    return (
      <div className="flex items-center justify-center gap-2 border-b border-success/30 bg-success/10 px-4 py-2 text-xs text-success">
        <WifiOff className="size-3.5" />
        Aplikacja jest gotowa do pracy offline.
      </div>
    );
  }

  return null;
}
