import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Database,
  Download,
  HardDrive,
  Moon,
  ShieldCheck,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react';

import { EnginePanel } from '@/components/engine-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/components/ui/toast';
import { useTheme } from '@/hooks/use-theme';
import {
  downloadBackup,
  importBackup,
  readStorageEstimate,
  requestPersistentStorage,
  type StorageEstimateInfo,
} from '@/lib/backup';
import { BUILD_ID, BUILD_TIME } from '@/lib/build-info';
import { wipeAllData } from '@/lib/db';
import { errorMessage, formatBytes } from '@/lib/utils';

export function SettingsPage(): React.JSX.Element {
  const { theme, toggle } = useTheme();
  const { toast } = useToast();
  const [storage, setStorage] = useState<StorageEstimateInfo | null>(null);
  const [working, setWorking] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refreshStorage = useCallback(async (): Promise<void> => {
    setStorage(await readStorageEstimate());
  }, []);

  useEffect(() => {
    void refreshStorage();
  }, [refreshStorage]);

  const handleExport = useCallback(async (): Promise<void> => {
    setWorking(true);
    try {
      await downloadBackup();
      toast({ title: 'Kopia zapasowa pobrana', variant: 'success' });
    } catch (error) {
      toast({ title: 'Eksport nie powiódł się', description: errorMessage(error), variant: 'error' });
    } finally {
      setWorking(false);
    }
  }, [toast]);

  const handleImport = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = event.target.files?.[0];
      if (file === undefined) return;

      setWorking(true);
      try {
        const summary = await importBackup(await file.text());
        toast({
          title: 'Kopia wczytana',
          description: `Materiały: ${summary.documents} · talie: ${summary.decks} · fiszki: ${summary.cards}`,
          variant: 'success',
        });
        await refreshStorage();
      } catch (error) {
        toast({ title: 'Import nie powiódł się', description: errorMessage(error), variant: 'error' });
      } finally {
        setWorking(false);
        if (fileInputRef.current !== null) fileInputRef.current.value = '';
      }
    },
    [refreshStorage, toast],
  );

  const handlePersist = useCallback(async (): Promise<void> => {
    const granted = await requestPersistentStorage();
    toast({
      title: granted ? 'Dane oznaczone jako trwałe' : 'Przeglądarka odmówiła trwałego zapisu',
      description: granted
        ? 'Przeglądarka nie usunie automatycznie Twoich fiszek ani wag modelu.'
        : 'Spróbuj ponownie po dodaniu aplikacji do ekranu głównego.',
      variant: granted ? 'success' : 'info',
    });
    await refreshStorage();
  }, [refreshStorage, toast]);

  const handleWipe = useCallback(async (): Promise<void> => {
    const confirmed = window.confirm(
      'Usunąć wszystkie materiały, talie i fiszki z tego urządzenia? Tej operacji nie można cofnąć.',
    );
    if (!confirmed) return;

    setWorking(true);
    try {
      await wipeAllData();
      toast({ title: 'Dane usunięte', variant: 'success' });
      await refreshStorage();
    } catch (error) {
      toast({ title: 'Nie udało się usunąć danych', description: errorMessage(error), variant: 'error' });
    } finally {
      setWorking(false);
    }
  }, [refreshStorage, toast]);

  const usagePercent =
    storage === null || storage.quotaBytes === 0
      ? 0
      : Math.min(100, Math.round((storage.usageBytes / storage.quotaBytes) * 100));

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-1 text-muted-foreground">
          <Link to="/dashboard">
            <ArrowLeft className="size-4" />
            Panel
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Ustawienia</h1>
        <p className="text-sm text-muted-foreground">
          Model AI, dane lokalne i wygląd aplikacji. Nic nie jest synchronizowane z serwerem.
        </p>
      </header>

      <EnginePanel />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="size-4 text-primary" />
            Miejsce na urządzeniu
          </CardTitle>
          <CardDescription>
            Licznik obejmuje bazę fiszek oraz wagi pobranego modelu językowego.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {storage === null ? (
            <p className="text-sm text-muted-foreground">
              Ta przeglądarka nie udostępnia informacji o zajętości pamięci.
            </p>
          ) : (
            <>
              <Progress value={usagePercent} />
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {formatBytes(storage.usageBytes)} z {formatBytes(storage.quotaBytes)} ({usagePercent}%)
                </span>
                {storage.persisted ? (
                  <Badge variant="success">zapis trwały</Badge>
                ) : (
                  <Badge variant="outline">zapis tymczasowy</Badge>
                )}
              </p>
            </>
          )}
          {storage !== null && !storage.persisted && (
            <Button variant="outline" size="sm" onClick={() => void handlePersist()}>
              <ShieldCheck className="size-4" />
              Poproś o trwały zapis
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="size-4 text-primary" />
            Kopia zapasowa danych
          </CardTitle>
          <CardDescription>
            Plik JSON zapisywany bezpośrednio na Twoim dysku — bez wysyłania do sieci.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void handleExport()} disabled={working}>
              <Download className="size-4" />
              Eksportuj dane
            </Button>
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={working}
            >
              <Upload className="size-4" />
              Importuj kopię
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => void handleImport(event)}
            />
          </div>
          <Separator />
          <div className="space-y-2">
            <p className="text-sm font-medium">Strefa nieodwracalna</p>
            <Button variant="destructive" onClick={() => void handleWipe()} disabled={working}>
              <Trash2 className="size-4" />
              Usuń wszystkie dane
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Wygląd</CardTitle>
          <CardDescription>Motyw jest zapisywany lokalnie w tej przeglądarce.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={toggle}>
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            {theme === 'dark' ? 'Przełącz na jasny' : 'Przełącz na ciemny'}
          </Button>
        </CardContent>
      </Card>

      <Card className="border-success/30 bg-success/5">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-success" />
            Prywatność
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p className="font-mono text-xs">
            Wersja aplikacji: {BUILD_ID} ({BUILD_TIME})
          </p>
          <p>
            CognitiveDeck nie ma backendu. Materiały, fiszki i historia powtórek zapisywane są w
            IndexedDB tej przeglądarki, a model językowy działa na Twoim GPU przez WebGPU.
          </p>
          <p>
            Jedyne połączenie sieciowe to jednorazowe pobranie wag modelu z publicznego repozytorium
            Hugging Face. Po nim aplikacja działa w pełni offline.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
