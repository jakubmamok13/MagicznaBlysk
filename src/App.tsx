import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { BrowserRouter } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { ErrorBoundary } from '@/components/error-boundary';
import { ToastProvider } from '@/components/ui/toast';
import { DashboardPage } from '@/pages/dashboard';

// Widoki cięższe od panelu wczytujemy na żądanie — szybszy pierwszy render.
const DocumentWorkspacePage = lazy(async () => ({
  default: (await import('@/pages/document-workspace')).DocumentWorkspacePage,
}));
const StudyPage = lazy(async () => ({
  default: (await import('@/pages/study')).StudyPage,
}));
const SettingsPage = lazy(async () => ({
  default: (await import('@/pages/settings')).SettingsPage,
}));

function RouteFallback(): React.JSX.Element {
  return (
    <div className="flex min-h-[40dvh] items-center justify-center text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
      <span className="ml-2 text-sm">Wczytywanie widoku…</span>
    </div>
  );
}

export function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <ToastProvider>
        {/* `BASE_URL` pozwala serwować aplikację z podkatalogu (GitHub Pages). */}
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route
                path="/documents/:documentId"
                element={
                  <Suspense fallback={<RouteFallback />}>
                    <DocumentWorkspacePage />
                  </Suspense>
                }
              />
              <Route
                path="/study/:deckId"
                element={
                  <Suspense fallback={<RouteFallback />}>
                    <StudyPage />
                  </Suspense>
                }
              />
              <Route
                path="/settings"
                element={
                  <Suspense fallback={<RouteFallback />}>
                    <SettingsPage />
                  </Suspense>
                }
              />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  );
}
