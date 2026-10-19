import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import fr from "../../messages/fr.json";

// Every static key the code reads through next-intl must exist in messages/fr.json: a missing or
// mistyped key renders as "Namespace.key" in every environment (src/i18n/request.ts silences the
// error). Translators are resolved by lexical scope from `useTranslations(ns?)`,
// `await getTranslations(ns? | { namespace? })` and `await Promise.all([...])` destructuring; calls are
// t("k"), t.rich, t.markup and t.raw (t.has probes optional keys). Keys built at runtime and
// translators received as parameters or props cannot be resolved statically: they are counted.

const SRC = path.resolve(__dirname, "../../src");
const FACTORIES = new Set(["useTranslations", "getTranslations"]);
const METHODS = new Set(["rich", "markup", "raw"]);

type Method = "call" | "rich" | "markup" | "raw";
interface Use {
  where: string;
  namespace: string;
  key: string;
  method: Method;
}
interface Scan {
  uses: Use[];
  namespaces: Array<{ where: string; namespace: string }>;
  /** Translator calls whose key or namespace is not a literal. */
  dynamic: string[];
  /** Calls through a parameter that shares a translator's name (translators passed as props or arguments). */
  parameters: string[];
}
type Binding = { kind: "translator"; namespace: string | null } | { kind: "parameter" } | { kind: "other" };

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}

/** Namespace of a translator factory call ("" for the root, null when not a literal); undefined for any other expression. */
function factoryNamespace(expression: ts.Expression): string | null | undefined {
  const call = unwrap(expression);
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || !FACTORIES.has(call.expression.text)) return undefined;
  const [arg] = call.arguments;
  if (!arg) return "";
  if (ts.isStringLiteralLike(arg)) return arg.text;
  if (!ts.isObjectLiteralExpression(arg)) return null;
  const property = arg.properties.find((p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === "namespace");
  if (!property) return "";
  return ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer) ? property.initializer.text : null;
}

function binds(name: ts.BindingName, identifier: string): boolean {
  if (ts.isIdentifier(name)) return name.text === identifier;
  return name.elements.some((element) => !ts.isOmittedExpression(element) && binds(element.name, identifier));
}

function fromDeclaration(declaration: ts.VariableDeclaration, identifier: string): Binding | null {
  if (!binds(declaration.name, identifier)) return null;
  let source: ts.Expression | undefined = declaration.initializer;
  if (ts.isArrayBindingPattern(declaration.name)) {
    // const [t, other] = await Promise.all([getTranslations(...), ...])
    const index = declaration.name.elements.findIndex((element) => ts.isBindingElement(element) && ts.isIdentifier(element.name) && element.name.text === identifier);
    const call = source && unwrap(source);
    const list = call && ts.isCallExpression(call) && call.expression.getText() === "Promise.all" ? call.arguments[0] : undefined;
    source = index >= 0 && list && ts.isArrayLiteralExpression(list) ? list.elements[index] : undefined;
  } else if (!ts.isIdentifier(declaration.name)) {
    return { kind: "other" };
  }
  const namespace = source ? factoryNamespace(source) : undefined;
  return namespace === undefined ? { kind: "other" } : { kind: "translator", namespace };
}

/** What `identifier` refers to at its position: the nearest enclosing parameter or block-level `const`/`let`. */
function resolve(identifier: ts.Identifier): Binding | null {
  const name = identifier.text;
  for (let node: ts.Node | undefined = identifier.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node) && node.parameters.some((parameter) => binds(parameter.name, name))) return { kind: "parameter" };
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      for (const statement of node.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          const found = fromDeclaration(declaration, name);
          if (found) return found;
        }
      }
    }
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node)) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
      if (node.initializer.declarations.some((declaration) => binds(declaration.name, name))) return { kind: "other" };
    }
  }
  return null;
}

/** Literal keys of a call argument (both branches of a literal conditional), or null when built at runtime. */
function literalKeys(arg: ts.Expression | undefined): string[] | null {
  if (!arg) return null;
  const node = unwrap(arg);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    const [whenTrue, whenFalse] = [literalKeys(node.whenTrue), literalKeys(node.whenFalse)];
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  return null;
}

function scanSource(fileName: string, text: string, translatorNames?: ReadonlySet<string>): Scan & { names: Set<string> } {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const scan: Scan & { names: Set<string> } = { uses: [], namespaces: [], dynamic: [], parameters: [], names: new Set() };
  const where = (node: ts.Node) => `${fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const call = unwrap(node.initializer);
      const list = ts.isCallExpression(call) && call.expression.getText(source) === "Promise.all" ? call.arguments[0] : undefined;
      const factories = list && ts.isArrayLiteralExpression(list) ? [...list.elements] : [call];
      for (const factory of factories) {
        const namespace = factoryNamespace(factory);
        if (namespace) scan.namespaces.push({ where: where(factory), namespace });
      }
      for (const element of ts.isIdentifier(node.name) ? [node.name] : ts.isArrayBindingPattern(node.name) ? node.name.elements : []) {
        const id = ts.isIdentifier(element) ? element : ts.isBindingElement(element) && ts.isIdentifier(element.name) ? element.name : null;
        if (id && fromDeclaration(node, id.text)?.kind === "translator") scan.names.add(id.text);
      }
    }
    if (ts.isCallExpression(node)) {
      let callee: ts.Identifier | null = null;
      let method: Method = "call";
      if (ts.isIdentifier(node.expression)) callee = node.expression;
      else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && METHODS.has(node.expression.name.text)) {
        callee = node.expression.expression;
        method = node.expression.name.text as Method;
      }
      const binding = callee && !FACTORIES.has(callee.text) ? resolve(callee) : null;
      if (binding?.kind === "translator") {
        const keys = literalKeys(node.arguments[0]);
        if (keys && binding.namespace !== null) for (const key of keys) scan.uses.push({ where: where(node), namespace: binding.namespace, key, method });
        else scan.dynamic.push(where(node));
      } else if (binding?.kind === "parameter" && callee && (translatorNames ?? scan.names).has(callee.text) && literalKeys(node.arguments[0])) {
        scan.parameters.push(where(node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return scan;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [full] : [];
  });
}

function scanAll(): Scan {
  const files = sourceFiles(SRC).map((file) => ({ name: path.relative(SRC, file), text: readFileSync(file, "utf8") }));
  const names = new Set(files.flatMap((file) => [...scanSource(file.name, file.text).names]));
  const all: Scan = { uses: [], namespaces: [], dynamic: [], parameters: [] };
  for (const file of files) {
    const scan = scanSource(file.name, file.text, names);
    all.uses.push(...scan.uses);
    all.namespaces.push(...scan.namespaces);
    all.dynamic.push(...scan.dynamic);
    all.parameters.push(...scan.parameters);
  }
  return all;
}

const lookup = (dotted: string): unknown => dotted.split(".").reduce<unknown>((node, key) => (typeof node === "object" && node !== null ? (node as Record<string, unknown>)[key] : undefined), fr);
const fullKey = (use: Use) => (use.namespace ? `${use.namespace}.${use.key}` : use.key);

describe("message keys", () => {
  const scan = scanAll();

  it("resolves translators by scope, Promise.all destructuring and literal keys", () => {
    const fixture = scanSource(
      "fixture.tsx",
      `async function Page({ locale }) {
         const t = await getTranslations({ locale, namespace: "A" });
         const [b, config, root] = await Promise.all([getTranslations({ locale, namespace: "B" }), getConfig(), getTranslations({ locale })]);
         const label = (t) => t("param");
         const code = t(\`six.\${id}\`);
         return [t("one"), t.rich("two", {}), b.raw(on ? "three" : "four"), root("C.five"), t.has("seven"), config("eight"), label, code];
       }
       function Island() {
         const t = useTranslations("D");
         return t.markup("nine");
       }`,
    );
    expect(fixture.uses.map((use) => `${fullKey(use)}:${use.method}`)).toEqual(["A.one:call", "A.two:rich", "B.three:raw", "B.four:raw", "C.five:call", "D.nine:markup"]);
    expect(fixture.namespaces.map((entry) => entry.namespace)).toEqual(["A", "B", "D"]);
    expect(fixture.dynamic).toEqual(["fixture.tsx:5"]);
    expect(fixture.parameters).toEqual(["fixture.tsx:4"]);
  });

  it("finds the translator calls of the code base (not vacuous)", () => {
    expect(scan.uses.length).toBeGreaterThan(700);
    expect(new Set(scan.namespaces.map((entry) => entry.namespace.split(".")[0])).size).toBeGreaterThan(15);
    // Unresolvable calls stay a small minority of what is checked.
    expect(scan.dynamic.length + scan.parameters.length).toBeLessThan(scan.uses.length / 5);
  });

  it("reads only namespaces that exist in fr.json", () => {
    const missing = scan.namespaces.filter((entry) => typeof lookup(entry.namespace) !== "object").map((entry) => `${entry.where} ${entry.namespace}`);
    expect(missing).toEqual([]);
  });

  it("reads only keys that exist in fr.json", () => {
    const missing = scan.uses
      .filter((use) => (use.method === "raw" ? lookup(fullKey(use)) === undefined : typeof lookup(fullKey(use)) !== "string"))
      .map((use) => `${use.where} ${fullKey(use)}`);
    expect(missing).toEqual([]);
  });
});
