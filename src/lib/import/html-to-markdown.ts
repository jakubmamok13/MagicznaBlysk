/**
 * Konwersja HTML (wynik mammotha dla .docx) na markdown.
 * Zachowujemy nagłówki, listy i akapity — dzięki temu podział materiału na
 * fragmenty trafia w granice sekcji, a nie w środek zdania.
 */

const HEADING_PREFIX: Record<string, string> = {
  H1: '#',
  H2: '##',
  H3: '###',
  H4: '####',
  H5: '#####',
  H6: '######',
};

export function htmlToMarkdown(html: string): string {
  if (typeof DOMParser === 'undefined') {
    throw new Error('Konwersja HTML wymaga środowiska przeglądarki.');
  }
  const document = new DOMParser().parseFromString(html, 'text/html');
  const blocks: string[] = [];
  collectBlocks(document.body, blocks);
  return blocks
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collectBlocks(node: Element, blocks: string[]): void {
  for (const child of Array.from(node.children)) {
    const tag = child.tagName.toUpperCase();

    const headingPrefix = HEADING_PREFIX[tag];
    if (headingPrefix !== undefined) {
      const text = inlineText(child);
      if (text.length > 0) blocks.push(`${headingPrefix} ${text}`);
      continue;
    }

    if (tag === 'UL' || tag === 'OL') {
      const items = Array.from(child.children)
        .filter((item) => item.tagName.toUpperCase() === 'LI')
        .map((item, index) => {
          const marker = tag === 'OL' ? `${index + 1}.` : '-';
          return `${marker} ${inlineText(item)}`;
        })
        .filter((line) => line.trim().length > 2);
      if (items.length > 0) blocks.push(items.join('\n'));
      continue;
    }

    if (tag === 'TABLE') {
      const rows = Array.from(child.querySelectorAll('tr'))
        .map((row) =>
          Array.from(row.children)
            .map((cell) => inlineText(cell))
            .join(' | '),
        )
        .filter((row) => row.replace(/[|\s]/g, '').length > 0);
      if (rows.length > 0) blocks.push(rows.join('\n'));
      continue;
    }

    if (tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'PRE') {
      const text = inlineText(child);
      if (text.length > 0) blocks.push(tag === 'BLOCKQUOTE' ? `> ${text}` : text);
      continue;
    }

    // Kontenery (div, section, article) — schodzimy głębiej.
    if (child.children.length > 0) {
      collectBlocks(child, blocks);
    } else {
      const text = inlineText(child);
      if (text.length > 0) blocks.push(text);
    }
  }
}

/** Tekst elementu z zachowaniem pogrubień i kursywy jako markdown. */
function inlineText(element: Element): string {
  let result = '';

  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3 /* Node.TEXT_NODE */) {
      result += node.textContent ?? '';
      continue;
    }
    if (node.nodeType !== 1 /* Node.ELEMENT_NODE */) continue;

    const child = node as Element;
    const tag = child.tagName.toUpperCase();
    const inner = inlineText(child);
    if (inner.trim().length === 0) continue;

    if (tag === 'STRONG' || tag === 'B') result += `**${inner}**`;
    else if (tag === 'EM' || tag === 'I') result += `*${inner}*`;
    else if (tag === 'CODE') result += `\`${inner}\``;
    else if (tag === 'BR') result += '\n';
    else result += inner;
  }

  return result.replace(/[ \t]+/g, ' ').trim();
}
