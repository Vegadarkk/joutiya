import { createHash } from "node:crypto";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemeScript } from "@/components/layout/theme-script";
import { inlineScripts, isFrameworkScript, PINNED_SCRIPT_HASHES, scriptHash, withScriptHashes } from "@/lib/security/inline-hashes";

const sha = (text: string) => createHash("sha256").update(text).digest("base64");
const BOOT = "(self.__next_f=self.__next_f||[]).push([0])";
const CHUNK = 'self.__next_f.push([1,"0:{\\"a\\":\\"\\u003cb\\u003e\\"}\\n"])';

describe("inlineScripts", () => {
  it("hashes the framework scripts and skips external and data scripts", () => {
    const html = `<script>${BOOT}</script><script src="/_next/a.js"></script><script type="application/ld+json">{"a":1}</script><script>${CHUNK}</script>`;
    expect(inlineScripts(html)).toEqual({ hashes: [sha(BOOT), sha(CHUNK)], untrusted: 0 });
  });

  it("leaves injected scripts unhashed, even disguised as framework scripts", () => {
    const injected = [
      "alert(1)",
      'self.__next_f.push([1,"x"]);alert(1)',
      'self.__next_f.push([1,"x"]),alert(1),(["y"])',
      `${BOOT};alert(1)`,
    ];
    const html = injected.map((body) => `<script>${body}</script>`).join("");
    expect(inlineScripts(html)).toEqual({ hashes: [], untrusted: injected.length });
  });

  it("normalizes newlines like browsers and deduplicates", () => {
    const body = 'self.__next_f.push([1,"a"])';
    expect(scriptHash(`${body}\r\n`)).toBe(sha(`${body}\n`));
    expect(inlineScripts(`<script>${BOOT}</script><SCRIPT>${BOOT}</SCRIPT>`).hashes).toEqual([sha(BOOT)]);
  });

  it("counts module and javascript types as executable", () => {
    expect(inlineScripts('<script type="module">alert(1)</script><script type="text/javascript">alert(2)</script>').untrusted).toBe(2);
  });
});

describe("pinned scripts", () => {
  it("trusts the theme script exactly as rendered", () => {
    const html = renderToString(<ThemeScript nonce="n" />);
    const { hashes, untrusted } = inlineScripts(html);
    expect(untrusted).toBe(0);
    expect(hashes).toHaveLength(1);
    expect(PINNED_SCRIPT_HASHES.has(hashes[0] ?? "")).toBe(true);
  });

  it("does not trust a modified theme script", () => {
    const html = renderToString(<ThemeScript />).replace("catch(_){}", "catch(_){alert(1)}");
    expect(inlineScripts(html)).toEqual({ hashes: [], untrusted: 1 });
    expect(isFrameworkScript("alert(1)")).toBe(false);
  });
});

describe("withScriptHashes", () => {
  it("replaces script-src with 'self' and the hashes", () => {
    const policy = "default-src 'self'; script-src 'self' 'unsafe-inline'; object-src 'none'";
    expect(withScriptHashes(policy, ["AAA=", "BBB="])).toBe("default-src 'self'; script-src 'self' 'sha256-AAA=' 'sha256-BBB='; object-src 'none'");
  });

  it("keeps 'unsafe-eval' when present (dev)", () => {
    expect(withScriptHashes("script-src 'self' 'unsafe-inline' 'unsafe-eval'", [])).toBe("script-src 'self' 'unsafe-eval'");
  });
});
