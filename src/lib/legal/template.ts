// Template layer of the legal pages (phase 6, D11): the Markdown sources in src/content/legal/
// carry `{key}` placeholders and conditional or repeated blocks written as HTML comments, so a
// source read without this engine still shows nothing extra. Client-safe and pure.
//
//   <!--if:key-->  <!--if:!key-->  <!--if:key=value-->  <!--if:key!=value-->  <!--else-->  <!--endif-->
//   <!--each:list--> ... {entry.field} ... <!--endeach-->
//
// A marker alone on its line takes the line with it, so a block inside a table or a list leaves no
// blank line behind. Any other comment is an editor's note and is dropped. "Notes for the review"
// sections never reach this file (they are cut when the drafts are imported).

export type TemplateValue = string | number | boolean | null | undefined | TemplateScope | readonly TemplateScope[];
export interface TemplateScope {
  readonly [key: string]: TemplateValue;
}

const MARKER = /<!--(if:[^>]*?|else|endif|each:[^>]*?|endeach)-->/g;
const OWN_LINE = /^[ \t]*(<!--(?:if:[^>]*?|else|endif|each:[^>]*?|endeach)-->)[ \t]*\r?\n/gm;
const NOTE = /<!--(?!(?:if:|else-->|endif-->|each:|endeach-->))[\s\S]*?-->\s*/g;
const PLACEHOLDER = /\{([A-Za-z][\w]*(?:\.[\w]+)*)\}/g;

type Node = string | { kind: "if"; test: string; then: Node[]; otherwise: Node[] } | { kind: "each"; list: string; body: Node[] };

function lookup(scope: TemplateScope, path: string): TemplateValue {
  let value: TemplateValue = scope;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as TemplateScope)[part];
  }
  return value;
}

function truthy(value: TemplateValue): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false && value !== "" && value !== 0;
}

/** A condition; a key absent from the scope (a typo) counts as missing, not as false. */
function test(expression: string, scope: TemplateScope, missing: Set<string>): boolean {
  const read = (key: string) => {
    const value = lookup(scope, key);
    if (value === undefined) missing.add(key);
    return value;
  };
  const comparison = /^([\w.]+)(!?=)(.*)$/.exec(expression);
  if (comparison) {
    const [, key, operator, expected] = comparison;
    const equal = String(read(key!) ?? "") === expected;
    return operator === "=" ? equal : !equal;
  }
  if (expression.startsWith("!")) return !truthy(read(expression.slice(1)));
  return truthy(read(expression));
}

function parse(source: string): Node[] {
  const root: Node[] = [];
  const stack: { nodes: Node[]; node?: Exclude<Node, string>; inElse?: boolean }[] = [{ nodes: root }];
  let last = 0;
  for (const match of source.matchAll(MARKER)) {
    const top = stack[stack.length - 1]!;
    if (match.index > last) top.nodes.push(source.slice(last, match.index));
    last = match.index + match[0].length;
    const marker = match[1]!;
    if (marker.startsWith("if:")) {
      const node: Node = { kind: "if", test: marker.slice(3).trim(), then: [], otherwise: [] };
      top.nodes.push(node);
      stack.push({ nodes: node.then, node });
    } else if (marker.startsWith("each:")) {
      const node: Node = { kind: "each", list: marker.slice(5).trim(), body: [] };
      top.nodes.push(node);
      stack.push({ nodes: node.body, node });
    } else if (marker === "else") {
      if (top.node?.kind !== "if" || top.inElse) throw new Error("legal template: <!--else--> outside an if block");
      top.inElse = true;
      top.nodes = top.node.otherwise;
    } else {
      const kind = marker === "endif" ? "if" : "each";
      if (top.node?.kind !== kind) throw new Error(`legal template: unexpected <!--${marker}-->`);
      stack.pop();
    }
  }
  if (stack.length > 1) throw new Error("legal template: unclosed block");
  if (last < source.length) stack[0]!.nodes.push(source.slice(last));
  return root;
}

function evaluate(nodes: Node[], scope: TemplateScope, missing: Set<string>, isolate: boolean): string {
  let out = "";
  for (const node of nodes) {
    if (typeof node === "string") {
      out += node.replace(PLACEHOLDER, (_, key: string) => {
        const value = lookup(scope, key);
        if (value === undefined || (typeof value === "object" && value !== null)) {
          missing.add(key);
          return "";
        }
        const text = value === null ? "" : String(value);
        return isolate && text ? `\u2068${text}\u2069` : text;
      });
    } else if (node.kind === "if") {
      out += evaluate(test(node.test, scope, missing) ? node.then : node.otherwise, scope, missing, isolate);
    } else {
      const list = lookup(scope, node.list);
      if (!Array.isArray(list)) {
        missing.add(node.list);
        continue;
      }
      for (const entry of list as readonly TemplateScope[]) out += evaluate(node.body, { ...scope, entry }, missing, isolate);
    }
  }
  return out;
}

export interface RenderedTemplate {
  text: string;
  /** Keys with no value (placeholders rendered empty, conditions and lists); the tests require none. */
  missing: string[];
}

/**
 * `isolate`: each value is wrapped in a bidi isolate (U+2068 ... U+2069), so a Latin name, address
 * or e-mail keeps its own order inside an Arabic sentence.
 */
export function renderTemplate(source: string, scope: TemplateScope, { isolate = false }: { isolate?: boolean } = {}): RenderedTemplate {
  const cleaned = source.replace(NOTE, "").replace(OWN_LINE, "$1");
  const missing = new Set<string>();
  const text = evaluate(parse(cleaned), scope, missing, isolate).replace(/\n{3,}/g, "\n\n");
  return { text, missing: [...missing] };
}
