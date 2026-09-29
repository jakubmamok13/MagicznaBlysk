/**
 * Katalog modeli sprawdzany na PRAWDZIWEJ konfiguracji WebLLM.
 *
 * Część offline (zawsze): każdy model z listy istnieje w `prebuiltAppConfig`,
 * a podana pamięć GPU zgadza się z danymi WebLLM — rada „najmniejszy model”
 * musi wynikać z liczb, nie z liczby parametrów.
 *
 * Część online (`npm run check:models`): pobiera `mlc-chat-config.json` każdego
 * modelu i sprawdza konfigurację dokładnie tak, jak zrobi to WebLLM przy
 * wczytywaniu. Gemma 3 nie wczytywała się przez konflikt okien
 * (context_window_size 4096 + sliding_window_size 512) — tego nie widać bez
 * zdalnej konfiguracji, a SwiftShader nie uruchomi modeli f16.
 */
import { prebuiltAppConfig } from '@mlc-ai/web-llm';
import { describe, expect, it } from 'vitest';

import { CHAT_OPTIONS } from '@/services/ai/engine';

import { MODEL_OPTIONS, recommendModel } from './models';

function record(id: string): (typeof prebuiltAppConfig.model_list)[number] {
  const found = prebuiltAppConfig.model_list.find((model) => model.model_id === id);
  if (found === undefined) throw new Error(`Brak modelu w WebLLM: ${id}`);
  return found;
}

describe('katalog modeli (offline)', () => {
  it.each(MODEL_OPTIONS.map((option) => [option.id, option] as const))(
    '%s istnieje w WebLLM i ma prawdziwą wartość pamięci GPU',
    (_id, option) => {
      const webllm = record(option.id);
      expect(Math.abs((webllm.vram_required_MB ?? 0) - option.vramMb)).toBeLessThan(10);
      expect(webllm.model_lib).toMatch(/webgpu\.wasm$/);
      expect(option.precision === 'f16').toBe(option.id.includes('f16'));
    },
  );

  it('na telefonie z shader-f16 automatycznie wybiera sprawdzony model, nie eksperymentalny', () => {
    const id = recommendModel({ isMobile: true, supportsF16: true, memoryGb: undefined });
    expect(id).toBe('Llama-3.2-1B-Instruct-q4f16_1-MLC');
  });
});

describe.runIf(process.env['CHECK_MODELS_ONLINE'] === '1')('katalog modeli (online)', () => {
  it.each(MODEL_OPTIONS.map((option) => [option.id] as const))(
    '%s: konfiguracja przechodzi walidację WebLLM, biblioteka i wagi istnieją',
    async (id) => {
      const webllm = record(id);
      const base = `${webllm.model.replace(/\/$/, '')}/resolve/main/`;
      const config = (await (await fetch(`${base}mlc-chat-config.json`)).json()) as Record<string, unknown>;
      // Ta sama kolejność scalania co w WebLLM: plik → overrides wpisu → nasze opcje.
      const merged = { ...config, ...(webllm.overrides ?? {}), ...CHAT_OPTIONS } as unknown as Record<string, number>;
      const context = merged['context_window_size'] ?? -1;
      const sliding = merged['sliding_window_size'] ?? -1;
      expect(context > 0 && sliding > 0, `context=${context}, sliding=${sliding}`).toBe(false);
      expect(context > 0 || sliding > 0).toBe(true);

      expect((await fetch(webllm.model_lib, { method: 'HEAD' })).ok).toBe(true);
      expect((await fetch(`${base}tensor-cache.json`, { method: 'HEAD' })).ok).toBe(true);
    },
    30_000,
  );
});
