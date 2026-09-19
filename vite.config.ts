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

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'robots.txt'],
      manifest: {
        id: '/',
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
        start_url: '/',
        scope: '/',
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
          { name: 'Panel', short_name: 'Panel', url: '/dashboard' },
          { name: 'Ustawienia', short_name: 'Ustawienia', url: '/settings' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        /**
         * Bundle WebLLM (silnik + worker) mają ~6 MB każdy. Nie wciągamy ich do
         * precache, żeby pierwsze wejście było lekkie — trafiają do cache przy
         * pierwszym uruchomieniu modelu i od tego momentu działają offline.
         */
        globIgnores: ['**/web-llm-*.js', '**/llm.worker-*.js'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
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
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    format: 'es',
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
