/**
 * Przygotowuje pliki OCR do serwowania z naszej domeny.
 *
 * Domyślnie tesseract.js pobiera rdzeń WASM i dane językowe z CDN. Ta aplikacja
 * obiecuje, że treść nie opuszcza urządzenia — więc hostujemy te pliki u siebie.
 * Efekt uboczny: po pierwszym użyciu OCR działa również offline.
 *
 * Uruchamiane automatycznie przed `dev` i `build` (patrz package.json).
 */
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIR = resolve(ROOT, 'public/tesseract');
const LANG_DIR = resolve(ROOT, 'public/tessdata');

/**
 * Warianty rdzenia: tesseract.js wybiera jeden zależnie od wsparcia SIMD.
 * Kopiujemy wyłącznie pliki `.wasm.js` — mają binarium osadzone w base64
 * i nigdy nie sięgają po osobny `.wasm` (te ważyłyby 8 MB bez żadnego pożytku).
 */
const CORE_FILES = [
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js',
];

/** Dane językowe — wariant `best_int` to najlepszy stosunek jakości do rozmiaru. */
const LANGUAGES = [
  {
    code: 'pol',
    url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/pol@1.0.0/4.0.0_best_int/pol.traineddata.gz',
    minBytes: 1_000_000,
  },
];

mkdirSync(CORE_DIR, { recursive: true });
mkdirSync(LANG_DIR, { recursive: true });

/* --------------------------- rdzeń i worker ---------------------------- */

const sources = [
  { from: resolve(ROOT, 'node_modules/tesseract.js/dist/worker.min.js'), name: 'worker.min.js' },
  ...CORE_FILES.map((name) => ({
    from: resolve(ROOT, 'node_modules/tesseract.js-core', name),
    name,
  })),
];

let copied = 0;
for (const source of sources) {
  if (!existsSync(source.from)) {
    console.error(`Brak pliku ${source.from} — czy zainstalowano zależności?`);
    process.exit(1);
  }
  const target = resolve(CORE_DIR, source.name);
  // Kopiujemy tylko przy zmianie rozmiaru — `npm run dev` startuje wtedy szybciej.
  if (!existsSync(target) || statSync(target).size !== statSync(source.from).size) {
    copyFileSync(source.from, target);
    copied += 1;
  }
}
console.log(`OCR: rdzeń tesseract gotowy (skopiowano ${copied} z ${sources.length} plików).`);

/* ----------------------------- dane językowe ---------------------------- */

for (const language of LANGUAGES) {
  const target = resolve(LANG_DIR, `${language.code}.traineddata.gz`);
  if (existsSync(target) && statSync(target).size >= language.minBytes) {
    console.log(`OCR: dane językowe ${language.code} już obecne.`);
    continue;
  }

  console.log(`OCR: pobieram dane językowe ${language.code}…`);
  const response = await fetch(language.url);
  if (!response.ok) {
    console.error(`Nie udało się pobrać ${language.url}: HTTP ${response.status}`);
    process.exit(1);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < language.minBytes) {
    console.error(`Pobrany plik ${language.code} jest podejrzanie mały (${bytes.length} B).`);
    process.exit(1);
  }
  writeFileSync(target, bytes);
  console.log(`OCR: zapisano ${language.code} (${(bytes.length / 1048576).toFixed(1)} MB).`);
}
