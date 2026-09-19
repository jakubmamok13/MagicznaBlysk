/** Przykładowy materiał — pozwala przetestować aplikację bez własnych notatek. */
export const SAMPLE_DOCUMENT_TITLE = 'Powtórki rozłożone w czasie — podstawy';

export const SAMPLE_DOCUMENT_CONTENT = `## Krzywa zapominania

Hermann Ebbinghaus wykazał w 1885 roku, że bez powtórek zapamiętany materiał
zanika wykładniczo: po 24 godzinach człowiek odtwarza około 33% wyuczonych
bezsensownych sylab. Zjawisko to nazywamy krzywą zapominania. Kluczowy wniosek
praktyczny jest taki, że tempo zapominania jest najszybsze bezpośrednio po nauce,
dlatego pierwsza powtórka powinna nastąpić w ciągu jednego dnia.

## Efekt rozłożenia w czasie

Powtarzanie tego samego materiału w odstępach czasu (uczenie rozłożone) daje
trwalsze efekty niż ta sama liczba powtórek wykonana w jednej sesji (uczenie
masowe). Mechanizm wyjaśnia teoria trudności pożądanej: każde przypomnienie
wykonane na granicy zapomnienia wymaga wysiłku, a wysiłek ten wzmacnia ślad
pamięciowy. Optymalny odstęp rośnie wraz z liczbą udanych przypomnień.

## Testowanie zamiast czytania

Aktywne przypominanie sobie odpowiedzi (efekt testowania) jest skuteczniejsze niż
ponowne czytanie notatek. W badaniu Roedigera i Karpicke z 2006 roku grupa, która
po lekturze tekstu wykonywała testy przypominania, po tygodniu odtwarzała 61%
materiału, podczas gdy grupa wielokrotnie czytająca ten sam tekst — 40%.
Z tego powodu fiszka powinna zawsze wymuszać odtworzenie odpowiedzi z pamięci,
a nie jej rozpoznanie.

## Algorytm SM-2

SM-2 to algorytm harmonogramowania powtórek opracowany przez Piotra Woźniaka dla
programu SuperMemo. Każda fiszka ma trzy parametry: odstęp w dniach, licznik
poprawnych powtórek oraz współczynnik łatwości (E-Factor) o wartości początkowej
2,5. Po ocenie odpowiedzi w skali od 1 do 5 algorytm wylicza nowy odstęp: dla
pierwszej poprawnej powtórki wynosi on 1 dzień, dla drugiej 6 dni, a dla każdej
kolejnej jest iloczynem poprzedniego odstępu i współczynnika łatwości. Ocena
poniżej 3 oznacza niepowodzenie: licznik powtórek wraca do zera, a fiszka wraca do
kolejki na następny dzień. Współczynnik łatwości nigdy nie spada poniżej 1,3, co
zapobiega powstawaniu fiszek powtarzanych codziennie bez końca.

## Atomowość fiszki

Dobra fiszka sprawdza dokładnie jeden fakt lub jeden krok procedury. Fiszka
złożona z kilku faktów prowadzi do częściowych pomyłek, przez co algorytm nie
potrafi poprawnie ocenić, który element wymaga powtórki. Jeśli odpowiedź wymaga
wyliczenia listy, należy rozbić ją na osobne fiszki albo zastosować lukę
w zdaniu.`;
