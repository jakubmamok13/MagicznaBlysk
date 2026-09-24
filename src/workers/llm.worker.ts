/// <reference lib="webworker" />
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';
import { GPU_EVENTS_CHANNEL, type GpuEvent } from '../services/ai/gpu-events';

/**
 * Model działa w dedykowanym Web Workerze, dzięki czemu generowanie fiszek
 * nie blokuje wątku głównego (animacje i interakcje pozostają płynne).
 */
const handler = new WebWorkerMLCEngineHandler();

self.onmessage = (event: MessageEvent): void => {
  handler.onmessage(event);
};

/**
 * WebLLM zapisuje utratę urządzenia GPU tylko do konsoli workera, której na
 * telefonie nie widać. Podpinamy się pod każde nowe urządzenie i przekazujemy
 * prawdziwą przyczynę do wątku głównego — trafia ona do raportu z generowania.
 * Osobny kanał (a nie postMessage) nie miesza się z protokołem WebLLM.
 */
function forwardGpuEvents(): void {
  if (typeof GPUAdapter === 'undefined' || typeof BroadcastChannel === 'undefined') return;

  const channel = new BroadcastChannel(GPU_EVENTS_CHANNEL);
  const send = (event: GpuEvent): void => {
    try {
      channel.postMessage(event);
    } catch {
      // Diagnostyka nie może zepsuć generowania.
    }
  };

  // Przez Reflect — metoda i tak jest wołana z właściwym `this` (call poniżej).
  const originalRequestDevice = Reflect.get(GPUAdapter.prototype, 'requestDevice');
  GPUAdapter.prototype.requestDevice = async function requestDevice(
    this: GPUAdapter,
    descriptor?: GPUDeviceDescriptor,
  ): Promise<GPUDevice> {
    const device = await originalRequestDevice.call(this, descriptor);
    void device.lost.then((info) => {
      send({ kind: 'lost', reason: info.reason, message: info.message, at: Date.now() });
    });
    device.addEventListener('uncapturederror', (event) => {
      send({ kind: 'error', reason: event.error.constructor.name, message: event.error.message, at: Date.now() });
    });
    return device;
  };
}

forwardGpuEvents();
