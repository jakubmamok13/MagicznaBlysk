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
- [Import materiałów](#import-materiałów)
- [OCR skanów](#ocr-skanów)
- [Potok AI](#potok-ai)
- [Generowanie w tle](#generowanie-w-tle)
- [Algorytm SM-2](#algorytm-sm-2)
- [Tryb offline i PWA](#tryb-offline-i-pwa)
- [Instalacja na telefonie](#instalacja-na-telefonie)
- [Wdrożenie](#wdrożenie)
- [Bez zewnętrznych usług](#bez-zewnętrznych-usług)
- [Publikacja przez GitHub](#publikacja-przez-github)
- [Dobór modelu do urządzenia](#dobór-modelu-do-urządzenia)
- [Zgodność z Safari](#zgodność-z-safari)
- [Wymagania przeglądarki](#wymagania-przeglądarki)
- [Testy i jakość kodu](#testy-i-jakość-kodu)
- [Decyzje projektowe](#decyzje-projektowe)

---

## Funkcje

| Widok | Co robi |
| --- | --- |
| `/dashboard` | Liczniki powtórek, lista talii z postępem, prognoza 7 dni, status silnika AI, import materiałów (PDF, Word, tekst, markdown — także wiele plików naraz) |
| `/documents/:id` | Podzielony warsztat: materiał źródłowy i kompendium po lewej, filtrowalna i edytowalna lista fiszek po prawej, przycisk „Generuj fiszki” |
| `/study/:deckId` | Tryb nauki bez rozproszeń: obrót 3D lub odsłanianie luki, skróty klawiszowe, podgląd cytatu źródłowego, cofanie oceny |
| `/settings` | Wybór i zarządzanie modelem, zajętość pamięci, kopia zapasowa (eksport/import JSON), motyw, kasowanie danych |

Dodatkowo:

- import wielu plików naraz: **PDF**, **Word (.docx)**, **.txt** i **.md** — parsowane w przeglądarce,
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
| `npm run cert` | certyfikat lokalny do HTTPS w sieci domowej (`scripts/generate-cert.mjs`) |
| `npm run build:pages` | build z `404.html` jako fallbackiem dla GitHub Pages |

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

## Import materiałów

Pliki są czytane w całości po stronie przeglądarki — żaden bajt nie trafia na serwer.

| Format | Biblioteka | Uwagi |
| --- | --- | --- |
| `.txt`, `.md` | — | odczyt natywny |
| `.pdf` | `pdfjs-dist` | tekst składany wg znacznika `hasEOL`, sklejanie wyrazów przenoszonych myślnikiem |
| `.docx` | `mammoth` | nagłówki, listy, tabele i pogrubienia zachowane jako markdown |

Zachowanie:

- **wiele plików naraz** — domyślnie każdy plik to osobny materiał z własną talią;
  opcja *Połącz w jeden materiał* scala je w jeden dokument z sekcjami `##`,
- **błąd jednego pliku nie przerywa reszty** — pozostałe wczytują się normalnie,
  a lista odrzuconych plików pokazuje konkretny powód,
- **skan PDF bez warstwy tekstowej** jest rozpoznawany i odrzucany z jasnym komunikatem
  (OCR nie jest wbudowany),
- pliki o tej samej nazwie i różnych rozszerzeniach dostają w tytule dopisek formatu,
- limit pojedynczego pliku to 25 MB; `.doc`, `.rtf`, `.odt` i prezentacje są odrzucane z podpowiedzią,
  na co je przekonwertować.

Parsery (`pdfjs-dist` ~437 kB, worker ~1,3 MB) ładują się dynamicznie — dopiero przy pierwszym
imporcie PDF-a. Kto wkleja tekst, nigdy ich nie pobiera.


## OCR skanów

PDF bez warstwy tekstowej (skan) nie jest odrzucany — w oknie importu pojawia się
przycisk **Rozpoznaj tekst (OCR)** z postępem i możliwością przerwania.

- silnik: `tesseract.js` z polskim modelem językowym,
- **wszystko lokalnie**: rdzeń WASM i dane językowe serwujemy z własnej domeny
  (`scripts/setup-ocr.mjs`), a nie z CDN — skan nie trafia do żadnej usługi,
- pierwsze użycie pobiera ok. 6 MB (rdzeń + model); potem OCR działa offline,
- strony renderowane są do bitmapy o szerokości ok. 1600 px — kompromis między
  jakością rozpoznania a pamięcią na telefonie,
- limit 30 stron na dokument, błąd pojedynczej strony nie przerywa całości,
- materiału bez rozpoznanego tekstu nie da się zaimportować do nauki.

Rozpoznany tekst zawsze warto przejrzeć — OCR bywa omylny, zwłaszcza przy
słabej jakości skanu.


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

## Generowanie w tle

Zadanie generowania żyje w store poza drzewem Reacta (`services/ai/generation-store.ts`),
tak samo jak stan silnika. Konsekwencje są praktyczne:

- okno generowania można zamknąć — proces trwa dalej,
- **pasek postępu w nagłówku** jest widoczny na każdym ekranie: etap, postęp,
  liczba fiszek, szacowany czas i przycisk zatrzymania,
- po zakończeniu pojawia się powiadomienie niezależnie od otwartego widoku,
- w danym momencie działa jedno zadanie — model i tak zajmuje całe GPU,
- gdy model nie jest wczytany, zadanie wczytuje go samo jako pierwszy etap.

Przebieg jest rozbity na etapy pokazywane użytkownikowi: *uruchamianie modelu →
analiza materiału → tworzenie fiszek (3/8) → zapis kompendium*. Czas do końca
liczymy ze średniej z już przetworzonych fragmentów i pokazujemy dopiero wtedy,
gdy jest z czego go policzyć. Na bieżąco widać też kilka ostatnio utworzonych fiszek.

### Odporność na awarię modelu

Model uruchomiony lokalnie potrafi paść — najczęściej przez brak pamięci GPU albo
utratę urządzenia przez sterownik. Potok jest na to przygotowany:

- fragmenty mają 1800 znaków, a budżet tokenów wyjścia dobierany jest do liczby
  zamawianych fiszek: okno kontekstu modeli to 4096 tokenów, a polszczyzna
  tokenizuje się gęściej niż angielski,
- błąd, po którym silnik nie nadaje się do pracy (utrata GPU, brak pamięci,
  przepełnienie kontekstu), **przerywa przebieg natychmiast** zamiast bezsensownie
  mielić pozostałe fragmenty martwym silnikiem,
- trzy błędy pod rząd też przerywają pracę — coś jest wtedy nie tak systemowo,
- po awarii model jest zwalniany, więc kolejna próba startuje na czystym urządzeniu,
- komunikat mówi wprost, ile fiszek ocalało i co zmienić (mniejszy model, mniej
  fiszek z fragmentu).

Ponowne uruchomienie generowania na tym samym materiale jest bezpieczne —
duplikaty są odrzucane po treści awersu, więc praca sprzed awarii nie ginie
ani się nie powiela.

Fiszki zapisują się **po każdym fragmencie**, nie zbiorczo na końcu — pojawiają się
od razu na liście materiału, a przerwanie albo awaria przeglądarki nie kasuje
dotychczasowej pracy modelu.


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

## Bez zewnętrznych usług

Aplikacja nie potrzebuje hostingu — wystarczy serwer statyczny na własnym komputerze.
Kluczowa obserwacja: **`localhost` jest bezpiecznym kontekstem**, więc Service Worker
(instalacja PWA, tryb offline) i WebGPU (model AI) działają tam bez żadnego certyfikatu.

### Na własnym komputerze

```bash
npm run build
npm run preview        # https/http://localhost:4173
```

To pełnoprawne uruchomienie: aplikację można zainstalować (Chrome: ikona instalacji w pasku
adresu), działa offline i generuje fiszki lokalnym modelem. Nie jest potrzebne nic poza
zależnościami projektu.

### Na telefonie w tej samej sieci Wi-Fi

Adres w sieci lokalnej (`http://192.168.x.x`) **nie** jest bezpiecznym kontekstem, więc telefon
nie zainstaluje PWA ani nie udostępni WebGPU. Rozwiązanie bez instalowania czegokolwiek —
certyfikat samopodpisany generowany przez `openssl` (obecny w macOS i Linuksie, w Windows
dostępny w Git Bash):

```bash
npm run cert           # wypisze adresy do otwarcia na telefonie
npm run build
npm run preview        # nasłuchuje też w sieci lokalnej
```

Na telefonie otwórz `https://<adres-komputera>:4173`. Przeglądarka ostrzeże o certyfikacie:

- **Android / Chrome** — *Zaawansowane* → *Przejdź do witryny*,
- **iOS / Safari** — *Szczegóły* → *Odwiedź tę stronę*; aby zadziałała instalacja PWA, trzeba
  dodatkowo zaufać certyfikatowi w *Ustawienia → Ogólne → Informacje → Zaufanie certyfikatom*.

Katalog `certs/` jest w `.gitignore` — certyfikat nigdy nie trafia do repozytorium.
Konfiguracja Vite wykrywa go automatycznie; bez certyfikatu wszystko działa jak dotąd po HTTP.

### Ograniczenia tego wariantu

- komputer musi być włączony i w tej samej sieci co telefon,
- adres jest prywatny — nie da się go otworzyć spoza sieci domowej,
- po instalacji PWA aplikacja działa offline, ale **pierwsze** wejście wymaga dostępu
  do serwera, a pierwsze pobranie wag modelu — dostępu do internetu.

Jeśli potrzebujesz adresu publicznego, użyj hostingu statycznego z sekcji
[Wdrożenie](#wdrożenie) — plik `dist/` można też po prostu przeciągnąć na stronę dostawcy.

## Publikacja przez GitHub

GitHub serwuje wyłącznie pliki statyczne — i dokładnie tego ta aplikacja potrzebuje, bo nie ma
backendu. Model językowy nadal działa na urządzeniu osoby, która otworzy stronę, a wagi pobierają
się z Hugging Face, więc hosting nie przenosi gigabajtów.

### GitHub Pages (automatycznie, przy każdym pushu)

W repozytorium jest gotowy workflow `.github/workflows/deploy.yml`:

1. wypchnij kod na `main`,
2. w repozytorium: **Settings → Pages → Source: GitHub Actions**,
3. każdy push uruchamia lint, testy i build, a następnie publikuje stronę.

Adres zależy od nazwy repozytorium:

| Repozytorium | Adres | `BASE_PATH` |
| --- | --- | --- |
| `<użytkownik>/MagicznaBlysk` | `https://<użytkownik>.github.io/MagicznaBlysk/` | `/MagicznaBlysk/` (ustawia workflow) |
| `<użytkownik>/<użytkownik>.github.io` | `https://<użytkownik>.github.io/` | `/` — zmień `BASE_PATH` w workflow |

Strona projektu działa w podkatalogu, dlatego build musi znać ścieżkę bazową — inaczej wszystkie
zasoby, manifest i zakres Service Workera wskazywałyby katalog główny i dawały 404. Workflow
podstawia nazwę repozytorium automatycznie; lokalnie:

```bash
BASE_PATH=/MagicznaBlysk/ npm run build:pages
```

`build:pages` dokłada `dist/404.html` (kopię `index.html`) — GitHub Pages używa go jako fallbacku
dla routingu po stronie klienta, dzięki czemu wejście wprost na `/study/3` otwiera aplikację.

Pages daje HTTPS, więc PWA instaluje się na telefonie, a WebGPU jest dostępne — to najprostszy
sposób, by mieć aplikację na telefonie bez trzymania włączonego komputera.

### GitHub Codespaces (uruchomienie bez konfiguracji lokalnej)

Jeśli chcesz tylko uruchomić aplikację, bez publikowania:

1. **Code → Codespaces → Create codespace**,
2. w terminalu: `npm install && npm run dev`,
3. otwórz przekierowany adres (Codespaces nadaje mu HTTPS).

Model i tak liczy się w Twojej przeglądarce, na Twoim GPU — Codespace tylko serwuje pliki.
Przekierowany port ustaw jako **Public**, jeśli chcesz otworzyć adres na telefonie.

## Dobór modelu do urządzenia

Nie każdy układ graficzny obsługuje te same modele, dlatego lista w panelu jest filtrowana:

- **brak rozszerzenia `shader-f16`** (częste na starszych układach mobilnych) — pokazywane są
  wyłącznie warianty **(f32)**; modele f16 nie skompilowałyby się w ogóle,
- **urządzenie mobilne** — pokazywane są tylko modele mieszczące się w limicie pamięci karty
  przeglądarki (0.5B–1B),
- **zapamiętany model niezgodny z urządzeniem** jest automatycznie podmieniany na zgodny,
  z informacją w panelu,
- błędy ładowania (`out of memory`, `device lost`, brak `shader-f16`) są tłumaczone na konkretną
  podpowiedź, co zrobić dalej.

Na telefonie realnie działają modele 0.5B–1B. Jeżeli nawet one nie ruszają — dotyczy to zwłaszcza
iPhone'ów, gdzie limit pamięci na kartę jest niski — wygeneruj fiszki na komputerze i przenieś je
kopią zapasową (opisane w [Instalacji na telefonie](#instalacja-na-telefonie)).

## Wymagania przeglądarki

| Funkcja | Wymaganie |
| --- | --- |
| Aplikacja, fiszki, nauka, offline | dowolna współczesna przeglądarka z IndexedDB |
| Generowanie fiszek przez AI | WebGPU: Chrome/Edge 113+, Safari 18+; zalecane 8 GB RAM i rozszerzenie `shader-f16` |

Brak WebGPU nie blokuje aplikacji — widoczny jest komunikat wyjaśniający, co nadal działa
i jak włączyć akcelerację.

## Testy i jakość kodu

```bash
npm run test     # 100 testów: SM-2, parser luk, chunking, weryfikacja cytatów, potok generowania
npm run lint     # ESLint (reguły typowane, zakaz `any`)
npm run build    # tsc -b + build produkcyjny
```

Potok generowania jest testowany ze zaślepionym silnikiem — sprawdzamy podział na fragmenty,
deduplikację między fragmentami, odporność na błąd fragmentu, przerwanie oraz politykę nadpisywania
kompendium.

## Zgodność z Safari

Trzy polyfille w `src/lib/polyfills.ts` są tu konieczne, nie ozdobne:

| Brakujące API | Kto tego wymaga | Skutek bez polyfilla |
| --- | --- | --- |
| `ReadableStream[Symbol.asyncIterator]` | `pdf.js` w `getTextContent()` | brak odczytu PDF w **każdym** Safari |
| `Map.prototype.getOrInsertComputed` | `pdf.js` przy renderowaniu stron | brak OCR w większości przeglądarek |
| `Promise.withResolvers` | `pdf.js` (biblioteka i worker) | brak odczytu PDF w Safari < 17.4 |

Wszystkie instalują się wyłącznie wtedy, gdy natywnej implementacji brakuje, i są
wykonywane także w zakresie workera (tam polyfill z wątku głównego nie sięga).

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
