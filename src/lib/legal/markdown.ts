// The Markdown subset of the legal pages (phase 6, D11), parsed into a tree that React renders
// (never HTML strings): headings with `{#id}` anchors, paragraphs, bullet and numbered lists,
// pipe tables, **bold**, *italic*, `code`, [links](href), bare https URLs and e-mail addresses.
// Client-safe and pure. Only same-site paths, anchors, https and mailto links survive.

export type Inline =
  | { type: "text"; value: string }
  | { type: "strong" | "em"; children: Inline[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; children: Inline[] };

export type MdBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4; id: string | null; children: Inline[]; text: string }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { type: "table"; head: Inline[][]; rows: Inline[][][] }
  | { type: "rule" };

const HEADING = /^(#{1,4})\s+(.*?)(?:\s+\{#([\w-]+)\})?\s*$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^(\d+)[.)]\s+(.*)$/;
const TABLE_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const RULE = /^(?:-{3,}|\*{3,})\s*$/;

/** A link target the page may carry; anything else is rendered as plain text. */
export function safeHref(href: string): string | null {
  // "/\host" is read as "//host" by browsers: a protocol-relative URL, never a same-site path.
  if (/^\/(?![/\\])/.test(href) || href.startsWith("#")) return href;
  if (/^https:\/\/[^\s]+$/.test(href) || /^mailto:[^\s@]+@[^\s@]+$/.test(href)) return href;
  return null;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (char === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else current += char;
  }
  cells.push(current.trim());
  return cells;
}

// Bidi isolates (U+2066-U+2069, around the values of an Arabic text) end a URL.
const AUTOLINK = /(https:\/\/[^\s<>()\u2066-\u2069]+[^\s<>().,;:!?»"')\u2066-\u2069]|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

function autolink(value: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of value.matchAll(AUTOLINK)) {
    if (match.index > last) out.push({ type: "text", value: value.slice(last, match.index) });
    const target = match[0];
    out.push({ type: "link", href: target.includes("@") && !target.startsWith("https://") ? `mailto:${target}` : target, children: [{ type: "text", value: target }] });
    last = match.index + target.length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

/** Characters a backslash makes literal (the template escapes them in config values). */
const ESCAPABLE = /[\\`*_[\](){}#|]/;

/**
 * Inline syntax: code, links, bold, italic, backslash escapes; the rest is text, with bare URLs and
 * e-mails linked except inside a link (`autolinks` false: no link in a link).
 */
export function parseInline(source: string, autolinks = true): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push(...(autolinks ? autolink(text) : [{ type: "text" as const, value: text }]));
    text = "";
  };
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    let match: RegExpExecArray | null;
    if (source[index] === "\\" && ESCAPABLE.test(source[index + 1] ?? "")) {
      text += source[index + 1];
      index += 2;
      continue;
    }
    if ((match = /^`([^`]+)`/.exec(rest))) {
      flush();
      out.push({ type: "code", value: match[1]! });
    } else if ((match = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      flush();
      const href = safeHref(match[2]!);
      const children = parseInline(match[1]!, false);
      if (href) out.push({ type: "link", href, children });
      else out.push(...children);
    } else if ((match = /^\*\*(.+?)\*\*/.exec(rest))) {
      flush();
      out.push({ type: "strong", children: parseInline(match[1]!, autolinks) });
    } else if ((match = /^\*([^*\s][^*]*?)\*/.exec(rest))) {
      flush();
      out.push({ type: "em", children: parseInline(match[1]!, autolinks) });
    } else {
      text += source[index];
      index += 1;
      continue;
    }
    index += match[0].length;
  }
  flush();
  return out;
}

/** Plain text of inline nodes (table of contents, tests). */
export function inlineText(nodes: Inline[]): string {
  return nodes.map((node) => ("children" in node ? inlineText(node.children) : node.value)).join("");
}

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let index = 0;
  const isBlockStart = (line: string, next: string | undefined) =>
    HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line) || RULE.test(line) || (line.trim().startsWith("|") && next !== undefined && TABLE_SEPARATOR.test(next));

  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const children = parseInline(heading[2]!);
      blocks.push({ type: "heading", level: heading[1]!.length as 1 | 2 | 3 | 4, id: heading[3] ?? null, children, text: inlineText(children) });
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }
    if (line.trim().startsWith("|") && lines[index + 1] !== undefined && TABLE_SEPARATOR.test(lines[index + 1]!)) {
      const head = splitRow(line).map((cell) => parseInline(cell));
      const rows: Inline[][][] = [];
      index += 2;
      while (index < lines.length && lines[index]!.trim().startsWith("|")) {
        rows.push(splitRow(lines[index]!).map((cell) => parseInline(cell)));
        index += 1;
      }
      blocks.push({ type: "table", head, rows });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index]!;
        const item = pattern.exec(current);
        if (item) items.push(ordered ? item[2]! : item[1]!);
        else if (current.trim() && /^\s+/.test(current) && items.length > 0) items[items.length - 1] += ` ${current.trim()}`;
        else break;
        index += 1;
      }
      blocks.push({ type: "list", ordered, start: numbered ? Number(numbered[1]) : 1, items: items.map((cell) => parseInline(cell)) });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() && !(paragraph.length > 0 && isBlockStart(lines[index]!, lines[index + 1]))) {
      paragraph.push(lines[index]!.trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join(" ")) });
  }
  return blocks;
}
