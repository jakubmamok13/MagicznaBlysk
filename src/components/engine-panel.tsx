import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  HardDriveDownload,
  Loader2,
  MonitorSmartphone,
  Power,
  RefreshCw,
  Trash2,
  WifiOff,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { useEngine } from '@/hooks/use-engine';
import { compatibleModels, findModel } from '@/lib/models';
import { cn, errorMessage } from '@/lib/utils';
import { llmEngine, type EngineState } from '@/services/ai/engine';

/* -------------------------------------------------------------------------- */
/*                            Wskaźnik stanu silnika                          */
/* -------------------------------------------------------------------------- */

export function EngineStatusBadge({ state }: { state: EngineState }): React.JSX.Element {
  switch (state.status) {
    case 'ready':
      return (
        <Badge variant="success">
          <CheckCircle2 className="size-3" /> Model gotowy
        </Badge>
      );
    case 'loading':
      return (
        <Badge variant="default">
          <Loader2 className="size-3 animate-spin" /> Wczytywanie {Math.round(state.progress * 100)}%
        </Badge>
      );
    case 'unsupported':
      return (
        <Badge variant="destructive">
          <AlertTriangle className="size-3" /> Brak WebGPU
        </Badge>
      );
    case 'error':
      return (
        <Badge variant="destructive">
          <AlertTriangle className="size-3" /> Błąd modelu
        </Badge>
      );
    case 'checking':
    case 'unchecked':
      return (
        <Badge variant="outline">
          <Loader2 className="size-3 animate-spin" /> Sprawdzanie…
        </Badge>
      );
    default:
      return (
        <Badge variant="outline">
          <Power className="size-3" /> Model niewczytany
        </Badge>
      );
  }
}

/* -------------------------------------------------------------------------- */
/*                         Panel modelu (pełna wersja)                        */
/* -------------------------------------------------------------------------- */

export interface EnginePanelProps {
  /** `compact` — wersja do paska bocznego workspace'u. */
  variant?: 'full' | 'compact';
  className?: string;
}

export function EnginePanel({
  variant = 'full',
  className,
}: EnginePanelProps): React.JSX.Element {
  const state = useEngine();
  const { toast } = useToast();
  const [busyAction, setBusyAction] = useState<'load' | 'unload' | 'remove' | null>(null);
  const model = findModel(state.modelId);
  // Pokazujemy wyłącznie modele, które mają szansę ruszyć na tym sprzęcie.
  const available = compatibleModels(state.profile);
  const filteredForF16 = state.profile.supportsF16 === false;
  const filteredForMobile = state.profile.isMobile;

  useEffect(() => {
    void llmEngine.initialize();
  }, []);

  const handleLoad = useCallback(async (): Promise<void> => {
    setBusyAction('load');
    try {
      await llmEngine.load();
      toast({
        title: 'Model gotowy do pracy',
        description: 'Generowanie fiszek odbywa się teraz w pełni na Twoim urządzeniu.',
        variant: 'success',
      });
    } catch (error) {
      toast({
        title: 'Nie udało się wczytać modelu',
        description: errorMessage(error),
        variant: 'error',
      });
    } finally {
      setBusyAction(null);
    }
  }, [toast]);

  const handleUnload = useCallback(async (): Promise<void> => {
    setBusyAction('unload');
    try {
      await llmEngine.unload();
      toast({ title: 'Model zwolniony', description: 'Pamięć GPU została odzyskana.' });
    } finally {
      setBusyAction(null);
    }
  }, [toast]);

  const handleRemoveCache = useCallback(async (): Promise<void> => {
    setBusyAction('remove');
    try {
      await llmEngine.removeFromCache(state.modelId);
      toast({
        title: 'Wagi modelu usunięte',
        description: 'Przy następnym uruchomieniu model zostanie pobrany ponownie.',
      });
    } catch (error) {
      toast({ title: 'Nie udało się usunąć wag', description: errorMessage(error), variant: 'error' });
    } finally {
      setBusyAction(null);
    }
  }, [state.modelId, toast]);

  const handleModelChange = useCallback(
    (modelId: string): void => {
      void llmEngine.selectModel(modelId);
    },
    [],
  );

  if (state.status === 'unsupported') {
    return <WebGpuFallback reason={state.webgpu.reason} className={className} />;
  }

  const isLoading = state.status === 'loading';
  const isReady = state.status === 'ready';
  const percent = Math.round(state.progress * 100);

  return (
    <Card className={className}>
      <CardHeader className={cn(variant === 'compact' && 'pb-3')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="size-4 text-primary" />
            Silnik AI na urządzeniu
          </CardTitle>
          <EngineStatusBadge state={state} />
        </div>
        {variant === 'full' && (
          <CardDescription>
            Model językowy działa lokalnie przez WebGPU. Materiały nie opuszczają tego urządzenia.
          </CardDescription>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Select value={state.modelId} onValueChange={handleModelChange} disabled={isLoading}>
            <SelectTrigger aria-label="Wybór modelu językowego">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {available.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  <span className="flex flex-col gap-0.5">
                    <span className="flex items-center gap-2 font-medium">
                      {option.label}
                      {option.recommended === true && !state.profile.isMobile && (
                        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                          zalecany
                        </Badge>
                      )}
                      {option.mobileFriendly === true && state.profile.isMobile && (
                        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                          na telefon
                        </Badge>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {option.downloadSize} · {option.description}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>Pobranie: {model?.downloadSize ?? 'nieznane'}</span>
            {state.cached ? (
              <span className="flex items-center gap-1 text-success">
                <WifiOff className="size-3" /> dostępny offline
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <HardDriveDownload className="size-3" /> jednorazowe pobranie
              </span>
            )}
            {state.webgpu.adapterLabel !== undefined && (
              <span className="flex items-center gap-1">
                <MonitorSmartphone className="size-3" /> {state.webgpu.adapterLabel}
              </span>
            )}
          </div>
        </div>

        {(filteredForF16 || filteredForMobile) && (
          <p className="text-xs text-muted-foreground">
            {filteredForF16
              ? 'Ta karta graficzna nie obsługuje obliczeń f16 — lista zawiera warianty „(f32)”, które na niej działają.'
              : 'Wykryto urządzenie mobilne — pokazujemy modele mieszczące się w limicie pamięci przeglądarki na telefonie.'}
          </p>
        )}

        {state.autoSwitchedFrom !== null && (
          <p className="rounded-md bg-accent/60 p-2.5 text-xs text-accent-foreground">
            Poprzednio wybrany model ({state.autoSwitchedFrom}) nie zadziała na tym urządzeniu —
            ustawiono zgodny zamiennik.
          </p>
        )}

        {isLoading && (
          <div className="space-y-2" aria-live="polite">
            <Progress value={percent} indeterminate={percent === 0} />
            <p className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="truncate">{state.progressText || 'Inicjalizacja…'}</span>
              <span className="tabular-nums">{percent}%</span>
            </p>
          </div>
        )}

        {state.error !== null && !isLoading && (
          <p className="flex items-start gap-2 rounded-md bg-destructive/10 p-2.5 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="whitespace-pre-line">{state.error}</span>
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {!isReady && (
            <Button onClick={() => void handleLoad()} disabled={isLoading || busyAction !== null}>
              {isLoading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : state.status === 'error' ? (
                <RefreshCw className="size-4" />
              ) : (
                <Download className="size-4" />
              )}
              {isLoading
                ? 'Wczytywanie…'
                : state.status === 'error'
                  ? 'Ponów próbę'
                  : state.cached
                    ? 'Uruchom model'
                    : 'Pobierz i uruchom model'}
            </Button>
          )}

          {isReady && (
            <Button
              variant="outline"
              onClick={() => void handleUnload()}
              disabled={busyAction !== null || state.busy}
            >
              <Power className="size-4" />
              Zwolnij pamięć GPU
            </Button>
          )}

          {state.cached && variant === 'full' && (
            <Button
              variant="ghost"
              onClick={() => void handleRemoveCache()}
              disabled={busyAction !== null || state.busy || isLoading}
            >
              <Trash2 className="size-4" />
              Usuń wagi z urządzenia
            </Button>
          )}
        </div>

        {variant === 'full' && !isReady && !isLoading && (
          <p className="text-xs text-muted-foreground">
            Model pobierany jest raz i zapisywany w pamięci przeglądarki — potem działa bez internetu.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*                        Fallback przy braku WebGPU                          */
/* -------------------------------------------------------------------------- */

export function WebGpuFallback({
  reason,
  className,
}: {
  reason?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <Card className={cn('border-warning/40 bg-warning/5', className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="size-4 text-warning" />
          Generowanie AI niedostępne na tym urządzeniu
        </CardTitle>
        <CardDescription>
          {reason ?? 'Ta przeglądarka nie udostępnia WebGPU, które jest wymagane do uruchomienia modelu lokalnie.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <p className="font-medium">Co nadal działa w pełni:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
            <li>dodawanie materiałów i czytanie ich w widoku dokumentu,</li>
            <li>ręczne tworzenie i edycja fiszek,</li>
            <li>nauka z algorytmem SM-2 wraz z całą statystyką,</li>
            <li>praca offline — wszystkie dane są na urządzeniu.</li>
          </ul>
        </div>
        <div>
          <p className="font-medium">Jak włączyć generowanie:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
            <li>użyj Chrome / Edge 113+ albo Safari 18+ na komputerze,</li>
            <li>włącz akcelerację sprzętową w ustawieniach przeglądarki,</li>
            <li>
              w Chrome sprawdź flagę <code className="rounded bg-muted px-1">chrome://gpu</code> —
              wiersz „WebGPU” powinien mieć status „Hardware accelerated”.
            </li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
