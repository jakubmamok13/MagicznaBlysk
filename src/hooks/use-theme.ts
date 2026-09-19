import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'cognitivedeck:theme';

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // Brak dostępu do localStorage — decyduje preferencja systemowa.
  }
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

/** Motyw aplikacji zapisany lokalnie; domyślnie zgodny z ustawieniem systemu. */
export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void; toggle: () => void } {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Ignorujemy brak zapisu — motyw pozostanie tylko na tę sesję.
    }
  }, [theme]);

  const setTheme = useCallback((next: Theme): void => setThemeState(next), []);
  const toggle = useCallback(
    (): void => setThemeState((current) => (current === 'dark' ? 'light' : 'dark')),
    [],
  );

  return { theme, setTheme, toggle };
}
