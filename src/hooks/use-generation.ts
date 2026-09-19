import { useSyncExternalStore } from 'react';

import { generationStore, type GenerationJob } from '@/services/ai/generation-store';

/** Stan generowania fiszek — wspólny dla okna dialogowego i paska w nagłówku. */
export function useGeneration(): GenerationJob {
  return useSyncExternalStore(
    generationStore.subscribe,
    generationStore.getState,
    generationStore.getState,
  );
}
