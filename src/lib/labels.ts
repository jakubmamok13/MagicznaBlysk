import type { CardType } from './db';

export interface CardTypeMeta {
  label: string;
  short: string;
  description: string;
  /** Klasy Tailwind dla oznaczenia typu. */
  tone: 'default' | 'secondary' | 'success' | 'warning';
}

export const CARD_TYPE_META: Record<CardType, CardTypeMeta> = {
  basic: {
    label: 'Pytanie i odpowiedź',
    short: 'Podstawowa',
    description: 'Klasyczna fiszka: pytanie na awersie, zwięzła odpowiedź na rewersie.',
    tone: 'default',
  },
  cloze: {
    label: 'Luka w zdaniu',
    short: 'Luka',
    description: 'Zdanie z ukrytą frazą w składni {{c1::…}} — odsłaniasz brakujący element.',
    tone: 'secondary',
  },
  case: {
    label: 'Przypadek praktyczny',
    short: 'Przypadek',
    description: 'Krótki scenariusz do rozwiązania — sprawdza zastosowanie wiedzy.',
    tone: 'warning',
  },
};

export const ENGINE_STATUS_LABELS: Record<string, string> = {
  unchecked: 'Nie sprawdzono',
  checking: 'Sprawdzanie WebGPU…',
  unsupported: 'WebGPU niedostępne',
  unloaded: 'Model niewczytany',
  loading: 'Wczytywanie modelu…',
  ready: 'Model gotowy',
  error: 'Błąd modelu',
};
