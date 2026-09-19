# CognitiveDeck

Progresywna aplikacja webowa (PWA) do nauki, w której **sztuczna inteligencja działa w 100% lokalnie
w przeglądarce** (WebGPU + WebLLM), a wszystkie dane zostają na urządzeniu (IndexedDB).
Wklejasz materiał → dostajesz kompendium i zestaw atomowych fiszek → uczysz się z algorytmem SM-2.

Brak backendu, brak kont, brak telemetrii. Jedyne połączenie z siecią to jednorazowe pobranie wag
modelu językowego; potem aplikacja działa offline.

---

## Spis treści

- [Funkcje](#funkcje)
- [Stos technologiczny](#stos-technologiczny)
- [Uruchomienie](#uruchomienie)
- [Skrypty](#skrypty)
- [Architektura](#architektura)
- [Model danych](#model-danych)
- [Potok AI](#potok-ai)
- [Algorytm SM-2](#algorytm-sm-2)
- [Tryb offline i PWA](#tryb-offline-i-pwa)
- [Instalacja na telefonie](#instalacja-na-telefonie)
- [Wdrożenie](#wdrożenie)
- [Wymagania przeglądarki](#wymagania-przeglądarki)
- [Testy i jakość kodu](#testy-i-jakość-kodu)
- [Decyzje projektowe](#decyzje-projektowe)

---

## Funkcje

| Widok | Co robi |
| --- | --- |
| `/dashboard` | Liczniki powtórek, lista talii z postępem, prognoza 7 dni, status silnika AI, import materiału |
| `/documents/:id` | Podzielony warsztat: materiał źródłowy i kompendium po lewej, filtrowalna i edytowalna lista fiszek po prawej, przycisk „Generuj fiszki” |
| `/study/:deckId` | Tryb nauki bez rozproszeń: obrót 3D lub odsłanianie luki, skróty klawiszowe, podgląd cytatu źródłowego, cofanie oceny |
| `/settings` | Wybór i zarządzanie modelem, zajętość pamięci, kopia zapasowa (eksport/import JSON), motyw, kasowanie danych |

Dodatkowo:

- trzy typy fiszek: `basic` (pytanie–odpowiedź), `cloze` (`{{c1::fraza}}`), `case` (scenariusz praktyczny),
- **każda wygenerowana fiszka ma cytat źródłowy zweryfikowany względem materiału** (patrz [Potok AI](#potok-ai)),
- ręczne dodawanie i edycja fiszek z walidacją składni luk,
- praca całkowicie offline po pierwszym uruchomieniu,
- czytelny fallback, gdy urządzenie nie obsługuje WebGPU — reszta aplikacji działa normalnie.

## Stos technologiczny

- **React 18 + TypeScript** (tryb `strict`, zakaz `any` egzekwowany przez ESLint) na **Vite 6**
- **Tailwind CSS 3** + komponenty w stylu **shadcn/ui** (Radix UI) + **Lucide Icons**
- **@mlc-ai/web-llm** — model językowy uruchamiany na GPU przez WebGPU, w dedykowanym Web Workerze
- **Dexie 4** (IndexedDB) + `dexie-react-hooks` (`useLiveQuery`)
- **vite-plugin-pwa** (Workbox) — instalowalność i praca offline
- **Vitest** — testy jednostkowe logiki (SRS, parsery, potok generowania)

## Uruchomienie

Wymagany Node.js 20+.

```bash
npm install
npm run dev          # http://localhost:5173
```

Wersja produkcyjna:

```bash
npm run build
npm run preview
```

> Service Worker jest aktywny wyłącznie w buildzie produkcyjnym (`devOptions.enabled = false`),
> żeby cache nie przeszkadzał w pracy nad kodem.

Przy pierwszym uruchomieniu kliknij **„Pobierz i uruchom model”** w panelu — plik wag
(0,7–1,9 GB zależnie od modelu) zostaje zapisany w pamięci przeglądarki i jest używany ponownie.

## Skrypty

| Polecenie | Opis |
| --- | --- |
| `npm run dev` | serwer deweloperski |
| `npm run build` | sprawdzenie typów (`tsc -b`) i build produkcyjny |
| `npm run preview` | podgląd builda (z działającym Service Workerem) |
| `npm run test` | testy jednostkowe (Vitest) |
| `npm run lint` | ESLint z regułami typowanymi |
| `npm run icons` | ponowne wygenerowanie ikon PWA (`scripts/generate-icons.mjs`) |

## Architektura

```
src/
├─ components/         komponenty UI aplikacji (panel silnika, dialogi, fiszka)
│  └─ ui/              prymitywy w stylu shadcn/ui (Button, Dialog, Select…)
├─ hooks/              useEngine, useKeyboardShortcuts, useTheme, useOnlineStatus
├─ lib/                logika bez Reacta: db, srs, cloze, text, stats, backup, webgpu
├─ pages/              dashboard, document-workspace, study, settings
├─ services/ai/        engine (WebLLM), prompt, schema (walidacja), generate (potok)
└─ workers/            llm.worker.ts — model działa poza wątkiem głównym
```

Zasada porządkująca: **`lib/` nie zna Reacta, `services/ai/` nie zna DOM-u, komponenty nie zawierają
logiki domenowej.** Dzięki temu SM-2, parser luk i walidacja odpowiedzi modelu są testowalne jako
czyste funkcje.

Stan silnika AI żyje poza drzewem Reacta (`llmEngine` + `useSyncExternalStore`), więc przełączanie
widoków nigdy nie przeładowuje modelu.

## Model danych

Baza `CognitiveDeckDB` (Dexie, wersja 1):

| Tabela | Indeksy | Pola |
| --- | --- | --- |
| `documents` | `++id, title, createdAt` | `title`, `rawContent`, `structuredSummary`, `createdAt` |
| `decks` | `++id, documentId, createdAt` | `documentId`, `name`, `createdAt` |
| `cards` | `++id, deckId, dueDate, type, createdAt, [deckId+dueDate]` | `type`, `front`, `back`, `sourceExcerpt`, `explanation`, `interval`, `repetitions`, `easeFactor`, `dueDate`, `leechCount`, `createdAt` |
| `studySessions` | `++id, deckId, isActive, updatedAt` | `deckId`, `currentCardIndex`, `totalReviewed`, `isActive`, `updatedAt` |

Indeksowane są tylko pola, po których realnie filtrujemy lub sortujemy — indeks na `rawContent`
czy `front` powiększałby bazę bez żadnej korzyści. Złożony indeks `[deckId+dueDate]` obsługuje
najczęstsze zapytanie aplikacji: „co jest do powtórki w tej talii”.

## Potok AI

1. **Podział materiału** (`lib/text.ts`) na fragmenty ≤ 2400 znaków, na granicach akapitów i zdań
   (z uwzględnieniem polskich skrótów typu `m.in.`), z zakładką między fragmentami.
2. **Zapytanie do modelu** dla każdego fragmentu — prompt systemowy wymaga kompendium,
   atomowych fiszek i dosłownego cytatu przy każdej z nich.
3. **Wymuszony JSON** — `response_format: { type: 'json_object', schema }`; dekoder WebLLM jest
   ograniczony gramatyką schematu, więc odpowiedź nie może być „prawie JSON-em”.
4. **Walidacja** (`services/ai/schema.ts`) — odrzucenie niekompletnych fiszek, naprawa składni luk
   (`{c1::x}` → `{{c1::x}}`), degradacja `cloze` bez luki do `basic`, deduplikacja awersów.
5. **Weryfikacja cytatu** (`lib/text.ts`) — cytat musi występować w materiale. Jeśli nie występuje
   dosłownie, jest podmieniany na najlepiej pokrywające się zdanie źródłowe (porównanie z lekkim
   stemmingiem, bo polski jest fleksyjny). **Fiszka bez pokrycia w źródle jest odrzucana** —
   to twarda realizacja wymogu, że każda fiszka ma potwierdzenie w materiale.
6. **Zapis** do IndexedDB po każdym fragmencie; przerwanie generowania zachowuje to, co już powstało.

Błąd pojedynczego fragmentu (np. brak pamięci GPU) nie przerywa całości — potok liczy niepowodzenia
i raportuje je w podsumowaniu.

## Algorytm SM-2

`lib/srs.ts` zawiera czystą funkcję:

```ts
calculateSM2(quality, repetitions, previousInterval, previousEaseFactor): SM2Result
```

- `quality < 3` → `repetitions = 0`, `interval = 1`, `leechCount + 1`,
- `quality >= 3` → `interval` kolejno `1`, `6`, a następnie `round(poprzedni × EF)`, `repetitions + 1`,
- `EF = max(1.3, EF + (0.1 - (5 - q) × (0.08 + (5 - q) × 0.02)))` — aktualizowany zawsze.

Cztery przyciski w widoku nauki mapują się na skalę 1–5: **Znowu → 1**, **Trudne → 3**,
**Dobre → 4**, **Łatwe → 5** („Znowu” musi być poniżej progu 3, aby zresetować serię).
Każdy przycisk pokazuje z wyprzedzeniem, kiedy wypadnie następna powtórka.

Skróty klawiszowe w trybie nauki: `spacja` / `Enter` — odsłonięcie, `1`–`4` — ocena,
`S` — cytat źródłowy, `U` — cofnięcie ostatniej oceny, `Esc` — wyjście, `?` — pomoc.

## Tryb offline i PWA

- Powłoka aplikacji (~725 kB) trafia do precache Workboksa i działa offline od pierwszej wizyty.
- Bundle WebLLM (~6 MB) jest **ładowany dynamicznie** i cache'owany dopiero przy pierwszym
  uruchomieniu modelu — użytkownik, który korzysta wyłącznie z ręcznych fiszek, nigdy go nie pobiera.
- Wagi modelu cache'uje sama biblioteka WebLLM (Cache API); Workbox celowo ich nie przechwytuje.
- Aktualizacje aplikacji wymagają potwierdzenia (`registerType: 'prompt'`), żeby nie przeładować
  strony w trakcie sesji nauki.
- W ustawieniach można poprosić przeglądarkę o trwały zapis (`navigator.storage.persist()`).

## Instalacja na telefonie

Aplikacja instaluje się jako PWA, ale **wymaga adresu HTTPS** — `http://192.168.x.x:5173`
z `vite dev --host` nie wystarczy: bez bezpiecznego kontekstu przeglądarka nie zarejestruje
Service Workera ani nie udostępni WebGPU. Masz dwie drogi:

- **wdrożenie** na dowolny hosting statyczny (patrz [Wdrożenie](#wdrożenie)) — rozwiązanie docelowe,
- **tunel na czas testów**, bez wdrażania:

  ```bash
  npm run build && npm run preview          # terminal 1
  npx cloudflared tunnel --url http://localhost:4173   # terminal 2 → adres https://…
  ```

### Dodanie do ekranu głównego

| System | Kroki |
| --- | --- |
| Android (Chrome 121+) | otwórz adres → menu ⋮ → **Zainstaluj aplikację** / *Dodaj do ekranu głównego* |
| iOS / iPadOS (Safari 18+) | otwórz adres w **Safari** (inne przeglądarki na iOS nie instalują PWA) → *Udostępnij* → **Dodaj do ekranu głównego** |

Po instalacji aplikacja startuje w trybie pełnoekranowym (`display: standalone`, orientacja pionowa)
i działa bez sieci.

### Generowanie fiszek na telefonie

Model językowy na telefonie to najbardziej wymagający element:

- w **Ustawieniach** wybierz **Llama 3.2 1B** (~0,7 GB) — pozostałe warianty zwykle nie mieszczą się
  w limicie pamięci karty przeglądarki na urządzeniu mobilnym,
- iOS ma ostry limit pamięci na kartę — na większości iPhone'ów wczytanie modelu się nie powiedzie;
  realne szanse mają iPady z układami M oraz najnowsze modele iPhone,
- Android wymaga Chrome 121+ z działającym WebGPU i kilku GB wolnego RAM-u.

Brak WebGPU nie blokuje aplikacji — nauka, ręczne fiszki i statystyki działają normalnie,
a widoczny komunikat wyjaśnia, czego brakuje.

### Zalecany układ pracy: generuj na komputerze, ucz się na telefonie

Dane są lokalne dla każdego urządzenia — **nie ma synchronizacji**. Fiszki przenosisz kopią zapasową:

1. na komputerze: **Ustawienia → Eksportuj dane** (plik `.json`),
2. przenieś plik na telefon (chmura, e-mail, AirDrop, kabel),
3. na telefonie: **Ustawienia → Importuj kopię** i wskaż plik.

Import nadaje nowe identyfikatory, więc nie nadpisuje tego, co już jest na urządzeniu.

### Trwałość danych na telefonie

Systemy mobilne czyszczą dane stron agresywniej niż komputery. Po instalacji wejdź w
**Ustawienia → Poproś o trwały zapis** i regularnie rób eksport — to jedyna kopia Twoich fiszek.

## Wdrożenie

`npm run build` tworzy statyczny katalog `dist/` — nie jest potrzebny żaden serwer aplikacyjny.
Ponieważ routing działa po stronie klienta (`BrowserRouter`), hosting **musi** kierować nieznane
ścieżki do `index.html`; inaczej wejście wprost na `/study/3` (np. z ikony na ekranie głównym)
zwróci 404. Gotowa konfiguracja jest w repozytorium:

| Hosting | Konfiguracja | Polecenie |
| --- | --- | --- |
| Netlify | `netlify.toml` | `npm run build` |
| Vercel | `vercel.json` | `npm run build` |
| Cloudflare Pages | `public/_redirects` | `npm run build` |
| GitHub Pages | `dist/404.html` jako fallback | `npm run build:pages` |

Pliki `sw.js` i `manifest.webmanifest` są oznaczone jako niecache'owalne przez CDN — bez tego
użytkownicy nie dostaliby aktualizacji aplikacji.

> Hosting serwuje wyłącznie pliki statyczne. Materiały, fiszki i model nadal nie opuszczają
> urządzenia użytkownika — serwer nigdy ich nie widzi.

## Wymagania przeglądarki

| Funkcja | Wymaganie |
| --- | --- |
| Aplikacja, fiszki, nauka, offline | dowolna współczesna przeglądarka z IndexedDB |
| Generowanie fiszek przez AI | WebGPU: Chrome/Edge 113+, Safari 18+; zalecane 8 GB RAM i rozszerzenie `shader-f16` |

Brak WebGPU nie blokuje aplikacji — widoczny jest komunikat wyjaśniający, co nadal działa
i jak włączyć akcelerację.

## Testy i jakość kodu

```bash
npm run test     # 43 testy: SM-2, parser luk, chunking, weryfikacja cytatów, potok generowania
npm run lint     # ESLint (reguły typowane, zakaz `any`)
npm run build    # tsc -b + build produkcyjny
```

Potok generowania jest testowany ze zaślepionym silnikiem — sprawdzamy podział na fragmenty,
deduplikację między fragmentami, odporność na błąd fragmentu, przerwanie oraz politykę nadpisywania
kompendium.

## Decyzje projektowe

- **`isActive` jako `0 | 1`** — IndexedDB nie indeksuje wartości logicznych, a pole jest indeksowane.
- **Model w Web Workerze** — generowanie nie blokuje interfejsu; postęp i przerwanie działają płynnie.
- **Znacznik pobranych modeli w `localStorage`** — status „dostępny offline” bez pobierania 6 MB
  kodu WebLLM przy starcie; dokładny stan cache sprawdzamy, gdy biblioteka i tak jest w pamięci.
- **Skróty klawiszowe w fazie przechwytywania** — React synchronicznie przetwarza zamknięcie modala
  Radixa w trakcie tego samego zdarzenia; nasłuch w fazie bąbelkowania łapałby to samo `Esc`
  i kończył sesję nauki.
- **Ocena „Znowu” wraca na koniec dzisiejszej kolejki** — fiszka jest zaplanowana na jutro (SM-2),
  ale w bieżącej sesji pojawia się jeszcze raz, zgodnie z praktyką systemów powtórkowych.
- **Brak `rehype-raw` w renderze markdown** — treść wklejona z internetu nie może wykonać HTML-a.
