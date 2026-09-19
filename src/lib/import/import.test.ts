// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { detectFormat, titleFromFileName, unsupportedReason } from './formats';
import { htmlToMarkdown } from './html-to-markdown';
import {
  installMapUpsert,
  installPromiseWithResolvers,
  installReadableStreamAsyncIterator,
} from '@/lib/polyfills';
import {
  describePdfError,
  disambiguateTitles,
  errorDetails,
  ExtractionError,
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

  it('nie wywraca się, gdy pdf.js nie zwróci tablicy', () => {
    // Bez tego `for..of` rzucałby „undefined is not a function”.
    expect(joinTextItems(undefined)).toBe('');
    expect(joinTextItems(null)).toBe('');
    expect(joinTextItems({ items: [] })).toBe('');
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
  it('przy niezgodności prosi o raport zamiast zgadywać przyczynę', () => {
    expect(describePdfError("undefined is not a function (near '...i of e...')")).toMatch(
      /Szczegóły techniczne/,
    );
  });

  it('rozpoznaje PDF z hasłem i uszkodzony plik', () => {
    expect(describePdfError('PasswordException: No password given')).toMatch(/hasłem/);
    expect(describePdfError('InvalidPDFException: Invalid PDF structure')).toMatch(/uszkodzony/);
  });

  it('pozostałe błędy przekazuje dalej', () => {
    expect(describePdfError('coś dziwnego')).toContain('coś dziwnego');
  });
});

describe('errorDetails i ExtractionError', () => {
  it('zawiera etap, nazwę błędu i początek stosu', () => {
    const details = errorDetails(new TypeError('undefined is not a function'), 'strona 3');
    expect(details).toContain('[strona 3]');
    expect(details).toContain('TypeError');
    expect(details).toContain('undefined is not a function');
  });

  it('radzi sobie z wartością, która nie jest błędem', () => {
    expect(errorDetails('coś poszło nie tak', 'test')).toContain('coś poszło nie tak');
  });

  it('ExtractionError niesie komunikat i szczegóły osobno', () => {
    const error = new ExtractionError('Przyjazny komunikat', '[etap] TypeError: szczegóły');
    expect(error.message).toBe('Przyjazny komunikat');
    expect(error.details).toContain('TypeError');
    expect(error).toBeInstanceOf(Error);
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

describe('polyfill ReadableStream[Symbol.asyncIterator]', () => {
  /** Safari nie wystawia tej metody — pdf.js opiera na niej getTextContent(). */
  function withoutNativeAsyncIterator(run: () => Promise<void>): Promise<void> {
    const proto = ReadableStream.prototype as unknown as Record<symbol, unknown>;
    const original = proto[Symbol.asyncIterator];
    delete proto[Symbol.asyncIterator];
    return run().finally(() => {
      if (original !== undefined) proto[Symbol.asyncIterator] = original;
    });
  }

  it('umożliwia `for await` po strumieniu, gdy brak natywnej obsługi', async () => {
    await withoutNativeAsyncIterator(async () => {
      installReadableStreamAsyncIterator();

      const stream = new ReadableStream<string>({
        start(controller) {
          controller.enqueue('Mitochondria');
          controller.enqueue('Rybosomy');
          controller.close();
        },
      });

      const chunks: string[] = [];
      for await (const chunk of stream as unknown as AsyncIterable<string>) chunks.push(chunk);
      expect(chunks).toEqual(['Mitochondria', 'Rybosomy']);
    });
  });

  it('przekazuje dalej błąd strumienia', async () => {
    await withoutNativeAsyncIterator(async () => {
      installReadableStreamAsyncIterator();

      const stream = new ReadableStream({
        start(controller) {
          controller.error(new Error('awaria strumienia'));
        },
      });

      await expect(
        (async () => {
          for await (const _chunk of stream as unknown as AsyncIterable<unknown>) void _chunk;
        })(),
      ).rejects.toThrow('awaria strumienia');
    });
  });

  it('nie nadpisuje natywnej implementacji', () => {
    const proto = ReadableStream.prototype as unknown as Record<symbol, unknown>;
    const before = proto[Symbol.asyncIterator];
    installReadableStreamAsyncIterator();
    expect(proto[Symbol.asyncIterator]).toBe(before);
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

describe('polyfill Map.prototype.getOrInsertComputed', () => {
  function withoutUpsert(run: () => void): void {
    const proto = Map.prototype as unknown as Record<string, unknown>;
    const computed = proto['getOrInsertComputed'];
    const insert = proto['getOrInsert'];
    delete proto['getOrInsertComputed'];
    delete proto['getOrInsert'];
    try {
      run();
    } finally {
      if (computed !== undefined) proto['getOrInsertComputed'] = computed;
      if (insert !== undefined) proto['getOrInsert'] = insert;
    }
  }

  it('wstawia wartość tylko przy pierwszym wywołaniu', () => {
    withoutUpsert(() => {
      installMapUpsert();
      const map = new Map<string, number>() as Map<string, number> & {
        getOrInsertComputed: (key: string, fn: (key: string) => number) => number;
      };

      let calls = 0;
      const first = map.getOrInsertComputed('a', () => {
        calls += 1;
        return 1;
      });
      const second = map.getOrInsertComputed('a', () => {
        calls += 1;
        return 2;
      });

      expect(first).toBe(1);
      expect(second).toBe(1);
      expect(calls).toBe(1);
      expect(map.get('a')).toBe(1);
    });
  });

  it('getOrInsert zwraca istniejącą wartość zamiast domyślnej', () => {
    withoutUpsert(() => {
      installMapUpsert();
      const map = new Map<string, string>([['k', 'stara']]) as Map<string, string> & {
        getOrInsert: (key: string, value: string) => string;
      };
      expect(map.getOrInsert('k', 'nowa')).toBe('stara');
      expect(map.getOrInsert('inny', 'nowa')).toBe('nowa');
    });
  });
});
