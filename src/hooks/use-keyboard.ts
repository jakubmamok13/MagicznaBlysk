import { useEffect, useRef } from 'react';

export type KeyHandlerMap = Record<string, (event: KeyboardEvent) => void>;

/**
 * Globalne skróty klawiszowe. Ignoruje zdarzenia z pól tekstowych,
 * aby pisanie w formularzach nie wywoływało akcji widoku nauki.
 */
export function useKeyboardShortcuts(handlers: KeyHandlerMap, enabled = true): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return;
        }
      }

      const handler = handlersRef.current[event.key];
      if (handler !== undefined) {
        event.preventDefault();
        handler(event);
      }
    };

    /**
     * Nasłuch w fazie przechwytywania (capture) jest tu istotny.
     * Radix zamyka modal na Escape swoim nasłuchem na `document`, a React
     * synchronicznie przetwarza tę zmianę stanu jeszcze w trakcie tego samego
     * zdarzenia — listener włączany ponownie („modal zamknięty”) złapałby więc
     * to samo naciśnięcie w fazie bąbelkowania i np. zakończył sesję nauki.
     * W fazie capture na `window` faza dla tego zdarzenia już minęła.
     */
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [enabled]);
}
