import { BUILD_ID, BUILD_TIME } from '@/lib/build-info';

import type { EngineState } from './engine';
import type { GenerationJob } from './generation-store';

/** Raport do wklejenia w zgłoszeniu — stan silnika, przebieg i surowa odpowiedź modelu. */
export function buildGenerationReport(job: GenerationJob, engine: EngineState): string {
  return [
    `CognitiveDeck build ${BUILD_ID} (${BUILD_TIME})`,
    `Model: ${engine.loadedModelId ?? engine.modelId} · stan: ${engine.status}`,
    `Urządzenie: ${engine.profile.isMobile ? 'mobilne' : 'komputer'} · shader-f16: ${
      engine.profile.supportsF16 === undefined ? '?' : engine.profile.supportsF16 ? 'tak' : 'nie'
    } · pamięć: ${engine.profile.memoryGb ?? '?'} GB`,
    `UA: ${navigator.userAgent}`,
    `Materiał: ${job.documentTitle}`,
    `Etap: ${job.phase} · fragmenty: ${job.chunkNumber}/${job.chunkCount} · odtworzenia silnika: ${job.modelReloads} · ucięte odpowiedzi: ${job.truncatedResponses}`,
    `Zdarzenia GPU: ${engine.gpuEvents.length > 0 ? engine.gpuEvents.join(' | ') : 'brak'}`,
    `Fiszki: dodano ${job.cardsAdded}, model zwrócił ${job.returned}`,
    `Odrzucone: ${job.rejected} · nieudane fragmenty: ${job.failedChunks}`,
    `Wynik: ${job.outcomeNote ?? job.message}`,
    job.error !== null ? `Błąd: ${job.error}` : '',
    engine.error !== null && engine.error !== job.error ? `Błąd silnika: ${engine.error}` : '',
    '',
    'Surowa odpowiedź modelu:',
    job.debugSample ?? '(brak próbki)',
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n');
}
