/**
 * Test gramatyki na PRAWDZIWYM silniku xgrammar z WebLLM (WebAssembly, bez GPU).
 *
 * Testy jednostkowe sprawdzają tekst gramatyki, ale nie to, jak zachowa się
 * dekoder. Tu ładujemy xgrammar z `node_modules/@mlc-ai/web-llm` i sprawdzamy:
 * - co gramatyka przyjmuje, a co odrzuca (pusta lista, białe znaki, kolejność pól),
 * - koszt maski tokenów na krok — wolna gramatyka oznacza setki razy wolniejsze
 *   generowanie na telefonie (tak było z `char{0,700}` i z `char*`).
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { buildCardGrammar } from './grammar';

interface Matcher {
  _acceptString(input: string): boolean;
  getNextTokenBitmask(): Promise<Int32Array>;
  dispose(): void;
}
interface XGrammar {
  Testings: { isGrammarAcceptString(grammar: string, input: string): Promise<boolean> };
  TokenizerInfo: { createTokenizerInfo(vocab: string[], type: string): Promise<unknown> };
  GrammarCompiler: {
    createGrammarCompiler(info: unknown): Promise<{ compileGrammar(grammar: string): Promise<unknown> }>;
  };
  GrammarMatcher: { createGrammarMatcher(compiled: unknown): Promise<Matcher> };
}

let xgr: XGrammar;

/**
 * xgrammar nie jest eksportowany przez WebLLM — robimy kopię modułu z jednym
 * dodatkowym eksportem i ścieżką, której wymaga środowisko Node.
 */
async function loadXGrammar(): Promise<XGrammar> {
  const source = resolve('node_modules/@mlc-ai/web-llm/lib/index.js');
  // W obrębie projektu (node_modules) — vitest nie ładuje plików spoza niego.
  const directory = resolve('node_modules/.cache/xgrammar-test');
  mkdirSync(directory, { recursive: true });
  const target = join(directory, 'webllm.mjs');
  copyFileSync(source, target);
  const patched = readFileSync(target, 'utf8').replaceAll('"MLC_DUMMY_PATH"', 'import.meta.url');
  writeFileSync(target, `${patched}\nexport { libExports$1 as __xgr };\n`);
  (globalThis as { createRequire?: typeof createRequire }).createRequire = createRequire;
  const module = (await import(/* @vite-ignore */ pathToFileURL(target).href)) as { __xgr: XGrammar };
  return module.__xgr;
}

beforeAll(async () => {
  xgr = await loadXGrammar();
}, 60_000);

const card = (patch: Record<string, string> = {}): Record<string, string> => ({
  type: 'basic',
  front: 'Co wytwarzają mitochondria?',
  back: 'ATP',
  sourceExcerpt: 'Mitochondria wytwarzają ATP w procesie fosforylacji.',
  explanation: 'Wynika to wprost z tekstu.',
  ...patch,
});
const answer = (cards: unknown[], summary = '### Mitochondria\n- wytwarzają ATP'): string =>
  JSON.stringify({ cards, summary });

describe('gramatyka fiszek w prawdziwym xgrammar', () => {
  const grammar = buildCardGrammar(['basic', 'cloze'], 2);
  const accepts = (input: string): Promise<boolean> => xgr.Testings.isGrammarAcceptString(grammar, input);

  it('przyjmuje kanoniczną odpowiedź z 1–2 fiszkami, polskimi znakami i sekwencjami ucieczki', async () => {
    expect(await accepts(answer([card()]))).toBe(true);
    expect(await accepts(answer([card(), card({ type: 'cloze', front: 'Mitochondria wytwarzają {{c1::ATP}}.' })]))).toBe(true);
    expect(await accepts(answer([card({ front: 'Zażółć „gęślą” "jaźń" 🙂?' })], 'a\nb\t"c"'))).toBe(true);
  });

  it('odrzuca pustą listę fiszek (stary schemat JSON ją dopuszczał)', async () => {
    expect(await accepts(answer([]))).toBe(false);
  });

  it('odrzuca więcej fiszek niż zamówiono', async () => {
    expect(await accepts(answer([card(), card(), card()]))).toBe(false);
  });

  it('odrzuca swobodne białe znaki (na nich małe modele „utykały”)', async () => {
    expect(await accepts(answer([card()]).replace('"cards":', '"cards": '))).toBe(false);
    expect(await accepts(answer([card()]).replace('],"summary"', '],\n"summary"'))).toBe(false);
  });

  it('wymaga fiszek przed kompendium i tylko wybranych typów', async () => {
    expect(await accepts(JSON.stringify({ summary: 'x', cards: [card()] }))).toBe(false);
    expect(await accepts(answer([card({ type: 'case' })]))).toBe(false);
  });

  it('maska tokenów jest tania na każdym kroku (inaczej generowanie na telefonie stoi)', async () => {
    // Syntetyczny słownik ~60 tys. tokenów (znaki, pary znaków i trójki) — koszt
    // wolnej ścieżki rośnie z rozmiarem słownika, więc różnica jest wyraźna.
    const alphabet = 'aąbcćdeęfghijklłmnńoóprsśtuwyzźżAĄBCĆDEĘFGHIJKLŁMNŃOÓPRSŚTUWYZŹŻ0123456789 .,:;?!-()"{}[]\\/#\n';
    const letters = [...alphabet];
    const vocab = new Set<string>(letters);
    for (const a of letters) for (const b of letters) vocab.add(a + b);
    outer: for (const a of letters.slice(0, 40)) {
      for (const b of letters) {
        for (const c of letters) {
          if (vocab.size >= 60_000) break outer;
          vocab.add(a + b + c);
        }
      }
    }
    const info = await xgr.TokenizerInfo.createTokenizerInfo([...vocab], 'raw');
    const compiler = await xgr.GrammarCompiler.createGrammarCompiler(info);
    const matcher = await xgr.GrammarMatcher.createGrammarMatcher(await compiler.compileGrammar(grammar));

    const text = answer([card(), card({ type: 'cloze', front: 'Mitochondria wytwarzają {{c1::ATP}}.' })]);
    let total = 0;
    for (const character of text) {
      expect(matcher._acceptString(character)).toBe(true);
      const started = performance.now();
      await matcher.getNextTokenBitmask();
      total += performance.now() - started;
    }
    matcher.dispose();

    // Cała odpowiedź (~350 kroków): szybka gramatyka ~kilka ms; wersja z `char*`
    // bez lookahead przekraczała ten próg wielokrotnie.
    expect(total).toBeLessThan(150);
  }, 60_000);
});
