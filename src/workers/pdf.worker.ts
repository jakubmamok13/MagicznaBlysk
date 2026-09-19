/// <reference lib="webworker" />

/**
 * Worker pdf.js opakowany naszym polyfillem.
 *
 * Kolejność importów jest tu istotna: polyfill musi wykonać się zanim wczyta
 * się kod pdf.js, który korzysta z `Promise.withResolvers()`. Polyfill z wątku
 * głównego nie obejmuje zakresu workera, dlatego potrzebny jest ten wrapper.
 */
import '@/lib/install-polyfills';
import 'pdfjs-dist/build/pdf.worker.min.mjs';
