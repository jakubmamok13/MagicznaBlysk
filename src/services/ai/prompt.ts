import type { CardType } from '@/lib/db';

/**
 * Prompt systemowy wymagany przez specyfikację produktu.
 * Zachowany dosłownie (angielski), z dopiskiem o języku wyjścia — materiały
 * i interfejs są polskie, więc treść fiszek również musi być po polsku.
 */
export const SYSTEM_PROMPT = `You are a university professor and cognitive science expert. Analyze the provided study material.
Strict requirements:
1. Synthesize the material into a structured compendium.
2. Deconstruct the content into atomic flashcards.
3. Atomicity Rule: Each card must test exactly one fact or procedural step.
4. Allowed card types: 'basic' (Q&A), 'cloze' (syntax: {{c1::target phrase}}), 'case' (practical scenario).
5. Every single card MUST include a 'sourceExcerpt' quoting the exact text segment confirming the answer.
Output strictly as JSON.

Language: the study material is written in Polish. Write the compendium, questions,
answers and explanations in Polish. Copy every 'sourceExcerpt' verbatim from the
material — never translate, paraphrase or invent it.`;

export interface ChunkPromptInput {
  /** Tytuł materiału — pomaga modelowi trzymać kontekst tematu. */
  documentTitle: string;
  /** Treść fragmentu do przetworzenia. */
  chunk: string;
  /** Numer fragmentu (liczony od 1) oraz łączna liczba fragmentów. */
  chunkNumber: number;
  chunkCount: number;
  /** Docelowa liczba fiszek z tego fragmentu. */
  targetCards: number;
  /** Dozwolone typy fiszek wybrane przez użytkownika. */
  allowedTypes: readonly CardType[];
}

const TYPE_HINTS: Record<CardType, string> = {
  basic: "'basic' — pytanie i zwięzła odpowiedź",
  cloze: "'cloze' — zdanie z luką w składni {{c1::fraza}} (pole front), w back pełna treść luki",
  case: "'case' — krótki scenariusz praktyczny i jego rozwiązanie",
};

/** Buduje wiadomość użytkownika dla jednego fragmentu materiału. */
export function buildChunkPrompt(input: ChunkPromptInput): string {
  const types = input.allowedTypes.map((type) => TYPE_HINTS[type]).join('\n- ');

  return `Materiał: „${input.documentTitle}”
Fragment ${input.chunkNumber} z ${input.chunkCount}.

--- POCZĄTEK FRAGMENTU ---
${input.chunk}
--- KONIEC FRAGMENTU ---

Zadania:
1. Pole "summary": zwięzłe kompendium TEGO fragmentu w markdown (nagłówek ###, 3–6 punktów
   z definicjami, zależnościami i wnioskami). Bez wstępów typu „W tym fragmencie…”.
2. Pole "cards": dokładnie ${input.targetCards} ${
    input.targetCards === 1 ? 'fiszka' : 'fiszek'
  } wyłącznie na podstawie powyższego fragmentu.

Dozwolone typy fiszek:
- ${types}

Zasady bezwzględne:
- Jedna fiszka = jeden fakt lub jeden krok procedury (atomowość).
- "sourceExcerpt" to dosłowny cytat (1–2 zdania) skopiowany znak w znak z fragmentu powyżej.
- "explanation" wyjaśnia, dlaczego odpowiedź jest poprawna (1–2 zdania).
- Nie powtarzaj tej samej treści w kilku fiszkach i nie wychodź poza fragment.
- Odpowiedz wyłącznie obiektem JSON zgodnym ze schematem.`;
}

/**
 * Prompt powtórki: krótki, wyłącznie po polsku i bez zadania pisania
 * kompendium. Mniejsze modele gubią się w długiej, dwujęzycznej instrukcji
 * i zwracają pustą listę fiszek — tutaj zostawiamy im jedno proste zadanie.
 */
export function buildRetryPrompt(input: ChunkPromptInput): string {
  const types = input.allowedTypes.join(', ');

  return `Tekst:
"""
${input.chunk}
"""

Napisz ${input.targetCards} fiszek do nauki z powyższego tekstu.
Dozwolone wartości pola "type": ${types}.
Dla każdej fiszki:
- "front": pytanie (dla typu cloze: zdanie z luką w składni {{c1::fraza}}),
- "back": krótka odpowiedź,
- "sourceExcerpt": fragment powyższego tekstu skopiowany dosłownie,
- "explanation": jedno zdanie uzasadnienia.

Pisz po polsku. Tablica "cards" nie może być pusta.`;
}
