import { describe, expect, it } from "vitest";
import { DEFAULT_LEGAL, missingLegalMentions, publisherIdentity, resolveLegalConfig, vatMention, type LegalConfig } from "@/config/legal";
import { LEGAL_PAGES, legalPage, type LegalSlug } from "@/config/legal-pages";
import { ARABIC_LEGAL_PAGES, LEGAL_VERSIONS, PROVISIONAL_LEGAL_PAGES } from "@/config/legal-versions";
import { SITE_NAME } from "@/config/site";
import { inlineText, parseInline, parseMarkdown, safeHref, type MdBlock } from "@/lib/legal/markdown";
import { legalSource } from "@/lib/legal/sources";
import { renderTemplate } from "@/lib/legal/template";
import { legalScope, type LegalSwitches } from "@/lib/legal/values";

const complete: LegalConfig = {
  ...DEFAULT_LEGAL,
  host: { name: "Oracle France SAS", address: "Paris", phone: "+33 1 00 00 00 00" },
  dataHosts: DEFAULT_LEGAL.dataHosts.map((host) => ({ ...host, address: host.address || "Dublin", phone: host.phone || "+353 1 000 0000" })),
};

describe("config/legal", () => {
  it("defaults to the EI publisher with the Paris domiciliation only", () => {
    expect(DEFAULT_LEGAL.legalForm).toBe("EI");
    expect(DEFAULT_LEGAL.hqAddress).toBe("6 rue d'Armaillé, 75017 Paris");
  });

  it("holds every host mention in the defaults and reports the missing ones", () => {
    expect(missingLegalMentions(DEFAULT_LEGAL)).toEqual([]);
    expect(missingLegalMentions(complete)).toEqual([]);
    const blank: LegalConfig = { ...DEFAULT_LEGAL, host: { name: "", address: "", phone: "" }, dataHosts: [{ ...DEFAULT_LEGAL.dataHosts[0]!, address: "", phone: "" }] };
    expect(missingLegalMentions(blank)).toEqual(["host.name", "host.address", "host.phone", "dataHosts[0].address", "dataHosts[0].phone"]);
  });

  it("requires capital and RCS city for a company", () => {
    const company: LegalConfig = { ...complete, legalForm: "SASU", shareCapital: "", rcsCity: "" };
    expect(missingLegalMentions(company)).toEqual(["shareCapital", "rcsCity"]);
  });

  it("requires a VAT number once liable", () => {
    expect(missingLegalMentions({ ...complete, vatRegime: "assujetti", vatNumber: "" })).toEqual(["vatNumber"]);
  });

  it("renders the publisher by legal form", () => {
    expect(publisherIdentity({ ...complete, entrepreneurName: "Prénom NOM" })).toBe("Prénom NOM, entrepreneur individuel (EI), nom commercial Adark Prime");
    expect(publisherIdentity({ ...complete, legalForm: "SASU", shareCapital: "1 000", rcsCity: "Paris" })).toBe(
      "Adark Prime, SASU au capital de 1 000 €, RCS Paris 947788303",
    );
    expect(vatMention(DEFAULT_LEGAL)).toBe("TVA non applicable, article 293 B du CGI");
    expect(vatMention({ ...DEFAULT_LEGAL, vatRegime: "assujetti" })).toBe("TVA intracommunautaire : FR41947788303");
  });

  it("merges the stored document over the defaults and rejects unknown or invalid fields", () => {
    expect(resolveLegalConfig(undefined)).toEqual({ config: DEFAULT_LEGAL, errors: [] });
    expect(resolveLegalConfig({ phone: "+33 1 23" }).config.phone).toBe("+33 1 23");
    const unknown = resolveLegalConfig({ personalAddress: "x" });
    expect(unknown.config).toBe(DEFAULT_LEGAL);
    expect(unknown.errors.length).toBeGreaterThan(0);
    expect(resolveLegalConfig({ siren: "123" }).errors[0]).toMatch(/^siren/);
  });
});

describe("legal pages", () => {
  type Language = "fr" | "ar";
  const OFF: LegalSwitches = { whatsapp: false, ads: false, adsCmpEea: false };
  const sources = LEGAL_PAGES.flatMap((page) =>
    (["fr", "ar"] as const).filter((language) => language === "fr" || ARABIC_LEGAL_PAGES.has(page.slug)).map((language) => ({ slug: page.slug, language })),
  );

  function render(slug: LegalSlug, language: Language, switches: Partial<LegalSwitches> = {}, config: LegalConfig = DEFAULT_LEGAL) {
    return renderTemplate(legalSource(slug, language), legalScope(config, { ...OFF, ...switches }, LEGAL_VERSIONS[slug], language), { isolate: language === "ar" });
  }

  /** The text of one section: from its heading to the next heading of the same or a higher level. */
  function section(text: string, id: string): string {
    const blocks = parseMarkdown(text);
    const start = blocks.findIndex((block) => block.type === "heading" && block.id === id);
    if (start < 0) return "";
    const level = (blocks[start] as Extract<MdBlock, { type: "heading" }>).level;
    const end = blocks.findIndex((block, index) => index > start && block.type === "heading" && block.level <= level);
    return JSON.stringify(blocks.slice(start, end < 0 ? undefined : end));
  }

  it("has a version, a French and an Arabic source for every page", () => {
    expect(Object.keys(LEGAL_VERSIONS).sort()).toEqual(LEGAL_PAGES.map((page) => page.slug).sort());
    expect(LEGAL_PAGES.filter((page) => page.column === "legal")).toHaveLength(9);
    expect([...PROVISIONAL_LEGAL_PAGES]).toEqual(["cgv"]);
    expect(sources).toHaveLength(LEGAL_PAGES.length + ARABIC_LEGAL_PAGES.size);
    expect(ARABIC_LEGAL_PAGES.size).toBe(LEGAL_PAGES.length);
  });

  it("renders every page with every key known and no marker left, whatever the configuration", () => {
    const company: LegalConfig = { ...complete, legalForm: "SASU", shareCapital: "1 000", rcsCity: "Paris", vatRegime: "assujetti", cndpReceiptNo: "D-1/2027", consumerMediator: { name: "Médiateur", url: "https://mediateur.example" } };
    const blank: LegalConfig = { ...DEFAULT_LEGAL, host: { name: "", address: "", phone: "" }, publicationDirector: "" };
    for (const { slug, language } of sources) {
      for (const config of [DEFAULT_LEGAL, complete, company, blank]) {
        for (const whatsapp of [false, true]) {
          for (const [ads, adsCmpEea] of [[false, false], [true, false], [true, true]] as const) {
            const { text, missing } = render(slug, language, { whatsapp, ads, adsCmpEea }, config);
            const where = `${language}/${slug} wa=${whatsapp} ads=${ads}/${adsCmpEea}`;
            expect(missing, where).toEqual([]);
            expect(text, where).not.toMatch(/<!--|-->|\{[A-Za-z][\w.]*\}/);
            expect(() => parseMarkdown(text), where).not.toThrow();
          }
        }
      }
    }
  });

  it("gives every anchored heading its id", () => {
    for (const { slug, language } of sources) {
      for (const block of parseMarkdown(render(slug, language, { whatsapp: true, ads: true, adsCmpEea: true }).text)) {
        if (block.type === "heading") expect(block.text, `${language}/${slug}`).not.toContain("{#");
      }
    }
  });

  it("opens every page with its title and its version line", () => {
    for (const { slug, language } of sources) {
      const blocks = parseMarkdown(render(slug, language).text);
      expect(blocks[0], `${language}/${slug}`).toMatchObject({ type: "heading", level: 1 });
      expect(inlineText((blocks[1] as Extract<MdBlock, { type: "paragraph" }>).children), `${language}/${slug}`).toContain(LEGAL_VERSIONS[slug].version);
    }
  });

  it("reads the brand from the site constant, never from the sources", () => {
    for (const { slug, language } of sources) {
      expect(legalSource(slug, language), `${language}/${slug}`).not.toMatch(/joutiya/i);
    }
    expect(render("cgu", "fr").text).toContain(SITE_NAME);
  });

  it("links only to existing pages and sections", () => {
    const ids = new Map<string, Set<string>>();
    const idsOf = (slug: LegalSlug, language: Language) => {
      const key = `${language}/${slug}`;
      if (!ids.has(key)) ids.set(key, new Set(parseMarkdown(render(slug, language, { whatsapp: true, ads: true, adsCmpEea: true }).text).flatMap((block) => (block.type === "heading" && block.id ? [block.id] : []))));
      return ids.get(key)!;
    };
    for (const { slug, language } of sources) {
      const text = render(slug, language, { whatsapp: true, ads: true, adsCmpEea: true }).text;
      for (const [, href] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        expect(safeHref(href!), `${language}/${slug}: ${href}`).not.toBeNull();
        const [path, anchor] = href!.split("#");
        if (!path) {
          expect(idsOf(slug, language), `${language}/${slug}: ${href}`).toContain(anchor);
          continue;
        }
        if (!path.startsWith("/")) continue;
        const target = /^\/legal\/([a-z-]+)$/.exec(path);
        expect(target, `${language}/${slug}: ${href}`).not.toBeNull();
        const page = legalPage(target![1]!);
        expect(page, `${language}/${slug}: ${href}`).toBeDefined();
        const targetLanguage = language === "ar" && ARABIC_LEGAL_PAGES.has(page!.slug) ? "ar" : "fr";
        if (anchor) expect(idsOf(page!.slug, targetLanguage), `${language}/${slug}: ${href}`).toContain(anchor);
      }
    }
  });

  it("keeps the same sections in French and Arabic", () => {
    for (const slug of ARABIC_LEGAL_PAGES) {
      const headings = (language: Language) => parseMarkdown(render(slug, language, { whatsapp: true, ads: true, adsCmpEea: true }).text).flatMap((block) => (block.type === "heading" && block.id ? [block.id] : []));
      expect(headings("ar"), slug).toEqual(headings("fr"));
    }
  });

  it("states no CNDP declaration until a receipt number is configured (C2-05)", () => {
    for (const language of ["fr", "ar"] as const) {
      expect(render("confidentialite", language).text).not.toContain("D-123/2027");
      expect(render("confidentialite", language, {}, { ...DEFAULT_LEGAL, cndpReceiptNo: "D-123/2027" }).text).toContain("D-123/2027");
    }
    expect(render("confidentialite", "fr").text).not.toMatch(/Déclaration auprès de la CNDP|CNDP[^.\n]*en cours/);
  });

  it("names Meta as a processor and the WhatsApp phone check only once it is live (D24)", () => {
    for (const language of ["fr", "ar"] as const) {
      const off = render("confidentialite", language).text;
      const on = render("confidentialite", language, { whatsapp: true }).text;
      for (const id of ["destinataires-2", "transferts"]) {
        expect(section(off, id), `${language} ${id}`).not.toContain("Meta");
        expect(section(on, id), `${language} ${id}`).toContain("Meta");
      }
      expect(section(off, "finalites-13"), language).toBe("");
      expect(section(on, "finalites-13"), language).not.toBe("");
      expect(render("confiance-et-securite", language, { whatsapp: true }).text.length).toBeGreaterThan(render("confiance-et-securite", language).text.length);
    }
    expect(render("confiance-et-securite", "fr").text).not.toContain("Téléphone vérifié");
    expect(render("confiance-et-securite", "fr", { whatsapp: true }).text).toContain("**Téléphone vérifié** : le numéro a été confirmé par WhatsApp.");
  });

  it("lists every cookie the app sets, and the ad cookies only while ads can run (C2-08)", () => {
    for (const language of ["fr", "ar"] as const) {
      const off = render("cookies", language).text;
      for (const name of ["__Host-session", "__Host-csrf", "__Host-did", "__Host-tsv", "jt_consent", "NEXT_LOCALE", "theme"]) expect(off, `${language} ${name}`).toContain(name);
      const on = render("cookies", language, { ads: true }).text;
      expect(on.length, language).toBeGreaterThan(off.length);
      expect(render("cookies", language, { ads: true, adsCmpEea: true }).text.length, language).toBeGreaterThan(on.length);
    }
  });

  it("prints no postal address but the configured ones", () => {
    for (const { slug, language } of sources) {
      expect(legalSource(slug, language), `${language}/${slug}`).not.toMatch(/\d+,? (rue|avenue|boulevard|bd|place) |شارع|زنقة/i);
    }
    const mentions = render("mentions-legales", "fr", {}, complete).text;
    expect(mentions).toContain("6 rue d'Armaillé, 75017 Paris");
    expect(mentions).toContain("Oracle France SAS");
  });
});

describe("legal templates", () => {
  const scope = { name: "Adark", empty: "", on: true, off: false, mode: "live", list: [{ x: "a" }, { x: "b" }], nested: { value: "v" } };

  it("fills placeholders and reports unknown keys", () => {
    expect(renderTemplate("{name} {nested.value} {nope}", scope)).toEqual({ text: "Adark v ", missing: ["nope"] });
  });

  it("keeps or drops conditional blocks, inline and on their own lines", () => {
    expect(renderTemplate("a<!--if:on--> b<!--endif--><!--if:off--> c<!--else--> d<!--endif-->", scope).text).toBe("a b d");
    expect(renderTemplate("<!--if:!empty-->x<!--endif--><!--if:mode=live-->y<!--endif--><!--if:mode!=live-->z<!--endif-->", scope).text).toBe("xy");
    expect(renderTemplate("| a |\n<!--if:off-->\n| b |\n<!--endif-->\n| c |\n", scope).text).toBe("| a |\n| c |\n");
  });

  it("repeats a block per entry", () => {
    expect(renderTemplate("<!--each:list-->\n- {entry.x} ({name})\n<!--endeach-->\n", scope).text).toBe("- a (Adark)\n- b (Adark)\n");
  });

  it("isolates each value for a right-to-left text, and URLs stop at the isolate", () => {
    const { text } = renderTemplate("{name} https://{name}.ma", scope, { isolate: true });
    expect(text).toBe("\u2068Adark\u2069 https://\u2068Adark\u2069.ma");
    expect(parseInline("\u2068https://cndp.ma\u2069 \u2068dpo@example.ma\u2069").filter((node) => node.type === "link").map((node) => (node as { href: string }).href)).toEqual(["https://cndp.ma", "mailto:dpo@example.ma"]);
  });

  it("keeps config values literal: one line, no Markdown", () => {
    const hostile = { ...scope, name: "x | y\n# Owned [a](https://evil.example) **b** {#id}" };
    const table = parseMarkdown(renderTemplate("| h |\n| --- |\n| {name} |\n", hostile).text);
    expect(table).toHaveLength(1);
    const rows = (table[0] as Extract<MdBlock, { type: "table" }>).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(1);
    // A bare URL in a value is still linked (the mediator's site); the Markdown around it is not.
    expect(inlineText(rows[0]![0]!)).toBe("x | y # Owned [a](https://evil.example) **b** {#id}");
    expect(rows[0]![0]!.map((node) => node.type)).toEqual(["text", "link", "text"]);
    const heading = parseMarkdown(renderTemplate("## Title {name} {#t}\n", hostile).text);
    expect(heading).toEqual([expect.objectContaining({ type: "heading", id: "t", text: "Title x | y # Owned [a](https://evil.example) **b** {#id}" })]);
  });

  it("drops editor notes without eating the blank line after them", () => {
    expect(parseMarkdown(renderTemplate("Para <!-- note -->\n\n## H {#h}\n", scope).text).map((block) => block.type)).toEqual(["paragraph", "heading"]);
  });

  it("drops editor notes and reports conditions or lists on unknown keys", () => {
    expect(renderTemplate("a <!-- note: {nope} --> b", scope)).toEqual({ text: "a b", missing: [] });
    expect(renderTemplate("<!--if:typo-->x<!--endif--><!--each:nolist-->y<!--endeach-->", scope).missing).toEqual(["typo", "nolist"]);
  });

  it("rejects unbalanced markers", () => {
    expect(() => renderTemplate("<!--if:on-->x", scope)).toThrow(/unclosed/);
    expect(() => renderTemplate("x<!--endif-->", scope)).toThrow(/unexpected/);
    expect(() => renderTemplate("<!--each:list-->x<!--endif-->", scope)).toThrow(/unexpected/);
    expect(() => renderTemplate("<!--if:on-->a<!--else-->b<!--else-->c<!--endif-->", scope)).toThrow(/else/);
  });
});

describe("legal Markdown", () => {
  it("parses headings with anchors, lists, tables and rules", () => {
    const blocks = parseMarkdown("# Title\n\n## 1. Part {#part}\n\ntext\non two lines\n\n- a\n- b\n\n3. c\n4. d\n\n| h1 | h2 |\n| --- | --- |\n| x | y |\n\n---\n");
    expect(blocks.map((block) => block.type)).toEqual(["heading", "heading", "paragraph", "list", "list", "table", "rule"]);
    expect(blocks[1]).toMatchObject({ level: 2, id: "part", text: "1. Part" });
    expect(inlineText((blocks[2] as Extract<MdBlock, { type: "paragraph" }>).children)).toBe("text on two lines");
    expect(blocks[4]).toMatchObject({ ordered: true, start: 3 });
    expect(blocks[5]).toMatchObject({ head: [[{ type: "text", value: "h1" }], [{ type: "text", value: "h2" }]], rows: [[[{ type: "text", value: "x" }], [{ type: "text", value: "y" }]]] });
  });

  it("keeps only same-site, anchor, https and mailto links", () => {
    expect(parseInline("[a](/legal/cgu#x) [b](https://cndp.ma) [c](mailto:dpo@example.ma) [d](javascript:alert(1)) [e](//evil.example) [f](http://x.example) [g](/\\evil.example)").filter((node) => node.type === "link").map((node) => (node as { href: string }).href)).toEqual(["/legal/cgu#x", "https://cndp.ma", "mailto:dpo@example.ma"]);
    expect(inlineText(parseInline("[d](javascript:alert(1))"))).toContain("d");
  });

  it("never nests a link in a link", () => {
    expect(parseInline("[contact@x.ma](mailto:contact@x.ma)")).toEqual([{ type: "link", href: "mailto:contact@x.ma", children: [{ type: "text", value: "contact@x.ma" }] }]);
  });

  it("reads anchors with underscores", () => {
    expect(parseMarkdown("### Docs {#liste-identity_documents}\n")[0]).toMatchObject({ id: "liste-identity_documents", text: "Docs" });
  });

  it("turns bare https URLs and e-mail addresses into links, and parses emphasis and code", () => {
    const nodes = parseInline("**bold** *it* `code` https://example.ma/x. dpo@example.ma");
    expect(nodes.map((node) => node.type)).toEqual(["strong", "text", "em", "text", "code", "text", "link", "text", "link"]);
    expect(nodes.filter((node) => node.type === "link").map((node) => (node as { href: string }).href)).toEqual(["https://example.ma/x", "mailto:dpo@example.ma"]);
  });
});
