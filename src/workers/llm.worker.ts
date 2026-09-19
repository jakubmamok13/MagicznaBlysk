/// <reference lib="webworker" />
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

/**
 * Model działa w dedykowanym Web Workerze, dzięki czemu generowanie fiszek
 * nie blokuje wątku głównego (animacje i interakcje pozostają płynne).
 */
const handler = new WebWorkerMLCEngineHandler();

self.onmessage = (event: MessageEvent): void => {
  handler.onmessage(event);
};
