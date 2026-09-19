/**
 * Generuje certyfikat samopodpisany do serwowania aplikacji po HTTPS
 * w sieci lokalnej — bez żadnych zewnętrznych usług i bibliotek.
 *
 * HTTPS jest potrzebny, bo Service Worker (instalacja PWA, tryb offline)
 * oraz WebGPU (model AI) działają wyłącznie w bezpiecznym kontekście.
 * `localhost` jest bezpiecznym kontekstem z definicji, ale adres w sieci
 * lokalnej (np. http://192.168.0.12) już nie — i właśnie tym adresem łączy
 * się telefon.
 *
 * Uruchomienie: npm run cert
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CERT_DIR = resolve(ROOT, 'certs');

/** Adresy IPv4 tego komputera w sieci lokalnej. */
function localAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

const addresses = localAddresses();
if (addresses.length === 0) {
  console.warn('Nie wykryto adresu w sieci lokalnej — certyfikat obejmie tylko localhost.');
}

mkdirSync(CERT_DIR, { recursive: true });

// SAN musi zawierać każdy adres, pod którym aplikacja będzie otwierana,
// inaczej przeglądarka odrzuci certyfikat mimo zaufania do niego.
const sans = [
  'DNS:localhost',
  'IP:127.0.0.1',
  'IP:::1',
  ...addresses.map((address) => `IP:${address}`),
].join(',');

const configPath = resolve(CERT_DIR, 'openssl.cnf');
writeFileSync(
  configPath,
  `[req]
distinguished_name = dn
x509_extensions = ext
prompt = no

[dn]
CN = CognitiveDeck Local

[ext]
subjectAltName = ${sans}
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
`,
  'utf8',
);

try {
  execFileSync(
    'openssl',
    [
      'req', '-x509',
      '-newkey', 'rsa:2048',
      '-nodes',
      '-keyout', resolve(CERT_DIR, 'key.pem'),
      '-out', resolve(CERT_DIR, 'cert.pem'),
      '-days', '365',
      '-config', configPath,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
} catch (error) {
  console.error('Nie udało się wygenerować certyfikatu. Czy openssl jest zainstalowany?');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

rmSync(configPath, { force: true });

console.log('Certyfikat zapisany w ./certs (ważny 365 dni).');
console.log('Uruchom: npm run build && npm run preview');
console.log('\nOtwórz na tym komputerze:  https://localhost:4173');
for (const address of addresses) {
  console.log(`Otwórz na telefonie:       https://${address}:4173`);
}
console.log(
  '\nPrzeglądarka ostrzeże o certyfikacie samopodpisanym — to oczekiwane.\n' +
    'Android/Chrome: „Zaawansowane” → „Przejdź do witryny”.\n' +
    'iOS/Safari: „Szczegóły” → „Odwiedź tę stronę”, a następnie w Ustawieniach\n' +
    'systemu zaufaj certyfikatowi, aby zadziałała instalacja PWA.',
);
