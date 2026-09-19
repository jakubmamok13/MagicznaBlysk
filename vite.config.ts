import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Wagi modeli WebLLM (shardy Hugging Face) są cache'owane przez samą bibliotekę
 * w Cache API, dlatego Workbox nie powinien ich przechwytywać. Cache'ujemy
 * natomiast biblioteki WASM oraz całą powłokę aplikacji (App Shell).
 */
/**
 * Certyfikat lokalny z `npm run cert` (katalog ./certs, poza repozytorium).
 * Gdy istnieje, serwer dev i podgląd chodzą po HTTPS — dzięki temu aplikację
 * można zainstalować jako PWA i użyć WebGPU także z telefonu w tej samej sieci.
 * Bez certyfikatu wszystko działa jak dotąd, po HTTP na localhoście.
 */
function localHttps(): { key: Buffer; cert: Buffer } | undefined {
  const key = fileURLToPath(new URL('./certs/key.pem', import.meta.url));
  const cert = fileURLToPath(new URL('./certs/cert.pem', import.meta.url));
  if (!existsSync(key) || !existsSync(cert)) return undefined;
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

const https = localHttps();

/**
 * Ścieżka bazowa aplikacji. GitHub Pages dla repozytorium projektu serwuje
 * stronę pod `/<nazwa-repo>/`, więc wszystkie odwołania (zasoby, manifest,
 * zakres Service Workera, routing) muszą ten przedrostek uwzględniać.
 * Domyślnie `/` — dla hostingu w katalogu głównym i pracy lokalnej.
 *
 * Użycie: BASE_PATH=/MagicznaBlysk/ npm run build
 */
const base = normalizeBase(process.env['BASE_PATH']);

function normalizeBase(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0 || value === '/') return '/';
  const withLeading = value.startsWith('/') ? value : `/${value}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'robots.txt'],
      manifest: {
        id: base,
        name: 'CognitiveDeck — nauka z lokalną AI',
        short_name: 'CognitiveDeck',
        description:
          'Zamień materiały do nauki w kompendium i fiszki SRS. Cała AI działa lokalnie w Twojej przeglądarce (WebGPU) — bez serwera.',
        lang: 'pl',
        dir: 'ltr',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: base,
        scope: base,
        categories: ['education', 'productivity'],
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        shortcuts: [
          { name: 'Panel', short_name: 'Panel', url: `${base}dashboard` },
          { name: 'Ustawienia', short_name: 'Ustawienia', url: `${base}settings` },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        /**
         * Bundle WebLLM (silnik + worker) mają ~6 MB każdy. Nie wciągamy ich do
         * precache, żeby pierwsze wejście było lekkie — trafiają do cache przy
         * pierwszym uruchomieniu modelu i od tego momentu działają offline.
         */
        globIgnores: [
          '**/web-llm-*.js',
          '**/llm.worker-*.js',
          '**/pdf-*.js',
          '**/tesseract/*.js',
          '**/pdf.worker*.js',
          '**/pdf.worker*.mjs',
        ],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        navigateFallback: `${base}index.html`,
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Rdzeń OCR i dane językowe — pobierane dopiero przy pierwszym OCR,
            // potem dostępne offline.
            urlPattern: /\/(tesseract|tessdata)\/[\w.-]+$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'ocr-runtime',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // pdf.js i jego workery — cache'owane przy pierwszym imporcie PDF-a.
            urlPattern: /\/assets\/pdf[\w.-]*-[\w-]+\.(js|mjs)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'pdfjs-runtime',
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 180 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Kod silnika WebLLM — cache'owany dopiero, gdy zostanie użyty.
            urlPattern: /\/assets\/(web-llm|llm\.worker)-[\w-]+\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'webllm-runtime',
              expiration: { maxEntries: 6, maxAgeSeconds: 60 * 60 * 24 * 180 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Biblioteki modeli (.wasm) z CDN MLC — niezbędne do pracy offline.
            urlPattern: /^https:\/\/raw\.githubusercontent\.com\/mlc-ai\/binary-mlc-llm-libs\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'mlc-model-libs',
              expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Wagi modeli obsługuje własny cache WebLLM — nie duplikujemy ich w Workboxie.
            urlPattern: /^https:\/\/huggingface\.co\/.*/i,
            handler: 'NetworkOnly',
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  define: {
    // Znacznik builda — pozwala jednoznacznie stwierdzić, którą wersję
    // aplikacji ma użytkownik (PWA potrafi długo serwować kopię z cache).
    __BUILD_ID__: JSON.stringify(
      (process.env['GITHUB_SHA'] ?? 'dev').slice(0, 7),
    ),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    /**
     * Klasyczne workery zamiast modułowych.
     * iOS Safari potrafi odmówić wczytania workera typu `module`
     * („Importing a module script failed”), zwłaszcza gdy żądanie przechodzi
     * przez Service Workera. Format IIFE wkleja wszystkie zależności do
     * jednego pliku i działa w każdej przeglądarce z obsługą Web Workers.
     */
    format: 'iife',
  },
  server: {
    // `host: true` wystawia serwer w sieci lokalnej (dostęp z telefonu).
    host: true,
    ...(https ? { https } : {}),
  },
  preview: {
    host: true,
    port: 4173,
    ...(https ? { https } : {}),
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        /**
         * Tylko WebLLM wydzielamy ręcznie (i tak ładowany dynamicznie).
         * Resztę dzieli Rollup wg realnych zależności — ręczne grupowanie
         * wciągało Reacta do chunku markdown, przez co ładował się zawsze.
         */
        manualChunks: (id) => (id.includes('@mlc-ai/web-llm') ? 'web-llm' : undefined),
      },
    },
  },
  optimizeDeps: {
    exclude: ['@mlc-ai/web-llm'],
  },
});
