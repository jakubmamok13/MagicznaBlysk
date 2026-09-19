import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Zabezpiecza aplikację przed „białym ekranem” w razie nieoczekiwanego błędu. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[CognitiveDeck] Nieobsłużony błąd interfejsu:', error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
    window.location.reload();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="max-w-md space-y-4 rounded-xl border bg-card p-6 text-center shadow-sm">
          <AlertTriangle className="mx-auto size-8 text-destructive" />
          <h1 className="text-lg font-semibold">Coś poszło nie tak</h1>
          <p className="text-sm text-muted-foreground">
            Twoje dane są bezpieczne — pozostają w lokalnej bazie na tym urządzeniu.
          </p>
          <pre className="max-h-32 overflow-auto rounded-md bg-muted p-2 text-left text-xs">
            {error.message}
          </pre>
          <Button onClick={this.handleReset}>
            <RotateCcw className="size-4" />
            Przeładuj aplikację
          </Button>
        </div>
      </div>
    );
  }
}
