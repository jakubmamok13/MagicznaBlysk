// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { detectFormat, titleFromFileName, unsupportedReason } from './formats';
import { htmlToMarkdown } from './html-to-markdown';
import { installPromiseWithResolvers } from '@/lib/polyfills';
import {
  describePdfError,
  disambiguateTitles,
  joinTextItems,
  mergeDocuments,
  normalizeWhitespace,
  type ExtractedDocument,
} from './extract';

describe('detectFormat', () => {
  it('rozpoznaje obsługiwane rozszerzenia niezależnie od wielkości liter', () => {
    expect(detectFormat('wyklad.PDF')).toBe('pdf');
    expect(detectFormat('notatki.DocX')).toBe('docx');
    expect(detectFormat('skrypt.md')).toBe('markdown');
    expect(detectFormat('tekst.txt')).toBe('text');
  });

  it('odrzuca nieobsługiwane formaty', () => {
    expect(detectFormat('stary.doc')).toBeNull();
    expect(detectFormat('obraz.png')).toBeNull();
    expect(unsupportedReason('stary.doc')).toContain('.docx');
    expect(unsupportedReason('slajdy.pptx')).toContain('Prezentacje');
  });
});

describe('titleFromFileName', () => {
  it('usuwa rozszerzenie i porządkuje separatory', () => {
    expect(titleFromFileName('fizjologia_uklad-krazenia.pdf')).toBe('fizjologia uklad krazenia');
    expect(titleFromFileName('.txt')).toBe('Materiał bez tytułu');
  });
});

describe('htmlToMarkdown', () => {
  it('zachowuje nagłówki, akapity i listy', () => {
    const md = htmlToMarkdown(
      '<h1>Tytuł</h1><p>Akapit z <strong>pogrubieniem</strong>.</p><ul><li>raz</li><li>dwa</li></ul>',
    );
    expect(md).toContain('# Tytuł');
    expect(md).toContain('Akapit z **pogrubieniem**.');
    expect(md).toContain('- raz');
    expect(md).toContain('- dwa');
  });

  it('numeruje listy uporządkowane', () => {
    expect(htmlToMarkdown('<ol><li>pierwszy</li><li>drugi</li></ol>')).toBe('1. pierwszy\n2. drugi');
  });

  it('schodzi w głąb kontenerów i pomija puste elementy', () => {
    const md = htmlToMarkdown('<div><div><p>Treść</p></div><p></p></div>');
    expect(md).toBe('Treść');
  });

  it('zamienia tabelę na czytelne wiersze', () => {
    const md = htmlToMarkdown('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>');
    expect(md).toBe('a | b\nc | d');
  });
});

describe('joinTextItems (PDF)', () => {
  it('składa wiersze według znacznika hasEOL', () => {
    const text = joinTextItems([
      { str: 'Mitochondria ', hasEOL: false },
      { str: 'wytwarzają ATP.', hasEOL: true },
      { str: '', hasEOL: true },
      { str: 'Rybosomy tworzą białka.', hasEOL: true },
    ]);
    expect(text).toBe('Mitochondria wytwarzają ATP.\n\nRybosomy tworzą białka.');
  });

  it('skleja wyrazy przeniesione myślnikiem', () => {
    const text = joinTextItems([
      { str: 'fosforyla-', hasEOL: true },
      { str: 'cja oksydacyjna', hasEOL: true },
    ]);
    expect(text).toBe('fosforylacja oksydacyjna');
  });

  it('pomija elementy bez tekstu', () => {
    expect(joinTextItems([{ hasEOL: true }, { str: 'ok', hasEOL: true }, null, 42])).toBe('ok');
  });
});

describe('mergeDocuments', () => {
  const make = (title: string, text: string): ExtractedDocument => ({
    fileName: `${title}.txt`,
    title,
    format: 'text',
    text,
    warnings: [],
  });

  it('pojedynczy plik zostaje bez zmian', () => {
    expect(mergeDocuments([make('A', 'treść A')], 'Zbiór')).toBe('treść A');
  });

  it('kilka plików dostaje nagłówek zbiorczy i sekcje', () => {
    const merged = mergeDocuments([make('A', 'treść A'), make('B', 'treść B')], 'Wykłady');
    expect(merged.startsWith('# Wykłady')).toBe(true);
    expect(merged).toContain('## A');
    expect(merged).toContain('## B');
  });
});

describe('describePdfError', () => {
  it('tłumaczy błąd starej przeglądarki na konkretną wskazówkę', () => {
    expect(describePdfError("undefined is not a function (near '...i of e...')")).toMatch(/zbyt stara/);
  });

  it('rozpoznaje PDF z hasłem i uszkodzony plik', () => {
    expect(describePdfError('PasswordException: No password given')).toMatch(/hasłem/);
    expect(describePdfError('InvalidPDFException: Invalid PDF structure')).toMatch(/uszkodzony/);
  });

  it('pozostałe błędy przekazuje dalej', () => {
    expect(describePdfError('coś dziwnego')).toContain('coś dziwnego');
  });
});

describe('disambiguateTitles', () => {
  const doc = (title: string, format: ExtractedDocument['format']): ExtractedDocument => ({
    fileName: `${title}.x`,
    title,
    format,
    text: 'treść',
    warnings: [],
  });

  it('dopisuje format, gdy tytuły się powtarzają', () => {
    const out = disambiguateTitles([doc('wyklad', 'pdf'), doc('wyklad', 'docx')]);
    expect(out.map((d) => d.title)).toEqual(['wyklad (PDF)', 'wyklad (Word)']);
  });

  it('nie zmienia unikalnych tytułów', () => {
    const out = disambiguateTitles([doc('a', 'pdf'), doc('b', 'docx')]);
    expect(out.map((d) => d.title)).toEqual(['a', 'b']);
  });
});

describe('normalizeWhitespace', () => {
  it('ujednolica końce linii i usuwa nadmiar pustych wierszy', () => {
    expect(normalizeWhitespace('a\r\n\r\n\r\n\r\nb   \n')).toBe('a\n\nb');
  });
});

describe('polyfill Promise.withResolvers', () => {
  it('instaluje działającą implementację, gdy brak natywnej', async () => {
    const original = Reflect.get(Promise, 'withResolvers') as unknown;
    try {
      Reflect.deleteProperty(Promise, 'withResolvers');
      installPromiseWithResolvers();

      const withResolvers = Reflect.get(Promise, 'withResolvers') as <T>() => {
        promise: Promise<T>;
        resolve: (value: T) => void;
        reject: (reason?: unknown) => void;
      };
      expect(typeof withResolvers).toBe('function');

      const ok = withResolvers<string>();
      ok.resolve('gotowe');
      await expect(ok.promise).resolves.toBe('gotowe');

      const bad = withResolvers<string>();
      bad.reject(new Error('błąd'));
      await expect(bad.promise).rejects.toThrow('błąd');
    } finally {
      if (typeof original === 'function') {
        Reflect.set(Promise, 'withResolvers', original);
      }
    }
  });

  it('nie nadpisuje natywnej implementacji', () => {
    const marker = (): unknown => 'natywna';
    const original = Reflect.get(Promise, 'withResolvers') as unknown;
    try {
      Reflect.set(Promise, 'withResolvers', marker);
      installPromiseWithResolvers();
      expect(Reflect.get(Promise, 'withResolvers')).toBe(marker);
    } finally {
      if (typeof original === 'function') Reflect.set(Promise, 'withResolvers', original);
      else Reflect.deleteProperty(Promise, 'withResolvers');
    }
  });
});
