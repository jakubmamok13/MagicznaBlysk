/** Kanał, którym worker z modelem zgłasza zdarzenia GPU do wątku głównego. */
export const GPU_EVENTS_CHANNEL = 'cognitivedeck-gpu-events';

export interface GpuEvent {
  /** `lost` — utrata urządzenia; `error` — nieprzechwycony błąd WebGPU. */
  kind: 'lost' | 'error';
  /** `GPUDeviceLostInfo.reason` albo nazwa klasy błędu (np. GPUOutOfMemoryError). */
  reason: string;
  message: string;
  at: number;
}

export function isGpuEvent(value: unknown): value is GpuEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.kind === 'lost' || candidate.kind === 'error') &&
    typeof candidate.reason === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.at === 'number'
  );
}

/**
 * Czy zdarzenie jest faktyczną awarią. Utrata z powodem `destroyed` to nasze
 * własne zwolnienie urządzenia (unload / przeładowanie modelu) — nie zgłaszamy.
 */
export function isGpuFailure(event: GpuEvent): boolean {
  return !(event.kind === 'lost' && event.reason === 'destroyed');
}

export function describeGpuEvent(event: GpuEvent): string {
  const label = event.kind === 'lost' ? `utrata urządzenia (${event.reason})` : event.reason;
  const message = event.message.trim().replace(/\s+/g, ' ').slice(0, 160);
  return message.length > 0 ? `${label}: ${message}` : label;
}
