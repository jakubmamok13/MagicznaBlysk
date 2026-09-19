/**
 * Generator ikon PWA — rysuje ikonę proceduralnie i koduje PNG przy pomocy
 * wbudowanego `zlib`, bez żadnych zależności graficznych.
 *
 * Uruchomienie: npm run icons
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/* ----------------------------- Paleta i kształty ---------------------------- */

const BG_TOP = [37, 42, 92];
const BG_BOTTOM = [15, 23, 42];
const ACCENT = [129, 140, 248];
const CARD = [248, 250, 252];

const SUPERSAMPLE = 3;

/** Wnętrze prostokąta o zaokrąglonych narożnikach (współrzędne 0–1). */
function insideRoundedRect(x, y, rect) {
  const { left, top, width, height, radius } = rect;
  const right = left + width;
  const bottom = top + height;
  if (x < left || x > right || y < top || y > bottom) return false;

  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** Obrót punktu wokół środka o zadany kąt (radiany). */
function rotate(x, y, angle, originX = 0.5, originY = 0.5) {
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const dx = x - originX;
  const dy = y - originY;
  return [originX + dx * cos - dy * sin, originY + dx * sin + dy * cos];
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * Kolor punktu ikony: talia trzech nachylonych kart na gradiencie.
 * @param {number} x 0–1
 * @param {number} y 0–1
 * @param {boolean} maskable czy zostawić bezpieczny margines (ikona maskowalna)
 */
function shade(x, y, maskable) {
  const scale = maskable ? 0.72 : 0.88;
  const sx = 0.5 + (x - 0.5) / scale;
  const sy = 0.5 + (y - 0.5) / scale;

  const background = mix(BG_TOP, BG_BOTTOM, y);

  const cards = [
    { angle: -0.22, rect: { left: 0.24, top: 0.2, width: 0.52, height: 0.6, radius: 0.08 }, color: ACCENT, alpha: 0.55 },
    { angle: -0.1, rect: { left: 0.26, top: 0.18, width: 0.52, height: 0.6, radius: 0.08 }, color: ACCENT, alpha: 0.8 },
    { angle: 0.02, rect: { left: 0.28, top: 0.16, width: 0.52, height: 0.62, radius: 0.08 }, color: CARD, alpha: 1 },
  ];

  let color = background;
  for (const card of cards) {
    const [rx, ry] = rotate(sx, sy, card.angle);
    if (insideRoundedRect(rx, ry, card.rect)) {
      color = mix(color, card.color, card.alpha);
    }
  }

  // Znak zapytania/iskra na wierzchniej karcie: trzy poziome linie tekstu.
  const [tx, ty] = rotate(sx, sy, 0.02);
  const lines = [
    { top: 0.3, left: 0.36, width: 0.3 },
    { top: 0.42, left: 0.36, width: 0.22 },
    { top: 0.58, left: 0.36, width: 0.34 },
  ];
  for (const line of lines) {
    if (
      insideRoundedRect(tx, ty, {
        left: line.left,
        top: line.top,
        width: line.width,
        height: 0.045,
        radius: 0.022,
      })
    ) {
      color = mix(BG_BOTTOM, ACCENT, line.top > 0.5 ? 0.85 : 0.25);
    }
  }

  return color;
}

/* --------------------------------- Kodowanie -------------------------------- */

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, maskable) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let offset = 0;

  for (let py = 0; py < size; py += 1) {
    raw[offset] = 0; // filtr: none
    offset += 1;
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          const [cr, cg, cb] = shade(x, y, maskable);
          r += cr;
          g += cg;
          b += cb;
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      raw[offset] = Math.round(r / samples);
      raw[offset + 1] = Math.round(g / samples);
      raw[offset + 2] = Math.round(b / samples);
      offset += 3;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // głębia bitowa
  header[9] = 2; // typ koloru: truecolor
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="CognitiveDeck">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#252a5c"/>
      <stop offset="1" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#bg)"/>
  <g transform="translate(32 32)">
    <rect x="-16" y="-19" width="32" height="38" rx="5" fill="#818cf8" opacity="0.55" transform="rotate(-12)"/>
    <rect x="-16" y="-20" width="32" height="38" rx="5" fill="#818cf8" opacity="0.8" transform="rotate(-6)"/>
    <rect x="-16" y="-21" width="32" height="39" rx="5" fill="#f8fafc" transform="rotate(1)"/>
    <g transform="rotate(1)" fill="#4338ca">
      <rect x="-9" y="-12" width="18" height="3" rx="1.5"/>
      <rect x="-9" y="-5" width="12" height="3" rx="1.5"/>
      <rect x="-9" y="6" width="20" height="3" rx="1.5" fill="#6366f1"/>
    </g>
  </g>
</svg>
`;

/* ---------------------------------- Zapis ---------------------------------- */

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { file: 'pwa-192x192.png', size: 192, maskable: false },
  { file: 'pwa-512x512.png', size: 512, maskable: false },
  { file: 'pwa-maskable-512x512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: false },
];

for (const target of targets) {
  const png = encodePng(target.size, target.maskable);
  writeFileSync(resolve(OUT_DIR, target.file), png);
  console.log(`${target.file} — ${(png.length / 1024).toFixed(1)} kB`);
}

writeFileSync(resolve(OUT_DIR, 'favicon.svg'), FAVICON_SVG, 'utf8');
console.log('favicon.svg — zapisany');
