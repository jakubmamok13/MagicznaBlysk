import { useSyncExternalStore } from 'react';
import { llmEngine, type EngineState } from '@/services/ai/engine';

/**
 * Subskrypcja stanu silnika WebLLM.
 * Store jest zewnętrzny wobec Reacta, więc korzystamy z `useSyncExternalStore`
 * — dzięki temu stan modelu przeżywa przełączanie widoków i nie duplikuje się.
 */
export function useEngine(): EngineState {
  return useSyncExternalStore(llmEngine.subscribe, llmEngine.getState, llmEngine.getState);
}

/** Czy można uruchomić generowanie (model gotowy i nic nie generuje). */
export function canGenerate(state: EngineState): boolean {
  return state.status === 'ready' && !state.busy;
}
