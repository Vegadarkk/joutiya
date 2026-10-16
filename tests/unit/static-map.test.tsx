import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import type { Locale } from "@/config/site";
import { StaticRegionsMap, type StaticRegionsMapProps } from "@/components/map/static-regions-map";
import { regionsSvg } from "@/lib/map/regions-paths";

function render(props: StaticRegionsMapProps, locale: Locale = "fr") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr}>
      <StaticRegionsMap {...props} />
    </NextIntlClientProvider>,
  );
}

const attr = (html: string, tag: RegExp, name: string) => tag.exec(html)?.[0].match(new RegExp(`${name}="([^"]*)"`))?.[1];

describe("StaticRegionsMap", () => {
  const casa = { citySlug: "casablanca", seed: "abc12345", locale: "fr" as const };

  it("renders the same markup for the same props", () => {
    const first = render(casa);
    expect(render(casa)).toBe(first);
    expect(first.length).toBeLessThan(40_000);
  });

  it("changes the marker with the seed but not the regions", () => {
    const a = render(casa);
    const b = render({ ...casa, seed: "zzz99999" });
    expect(a).not.toBe(b);
    expect(a.split("<g data-testid=\"static-map-marker\">")[0]).toBe(b.split("<g data-testid=\"static-map-marker\">")[0]);
  });

  it("draws the 12 regions, highlights the listing's region and places the marker inside the viewBox", () => {
    const html = render(casa);
    expect(html).toContain('data-testid="static-map"');
    expect(html.match(/data-region="\d\d"/g)).toHaveLength(12);
    expect(html.match(/data-active="true"/g)).toHaveLength(1);
    expect(html).toContain('data-region="06" data-active="true"');
    const { projection } = regionsSvg();
    expect(html).toContain(`viewBox="${projection.viewBox}"`);
    const cx = Number(attr(html, /<circle[^>]*>/, "cx"));
    const cy = Number(attr(html, /<circle[^>]*>/, "cy"));
    expect(projection.contains([cx, cy])).toBe(true);
    // Casablanca (7.6° W, 33.6° N) sits at ~59 % of the box width and in the upper fifth of its height.
    expect(cx).toBeGreaterThan(projection.width * 0.55);
    expect(cx).toBeLessThan(projection.width * 0.65);
    expect(cy).toBeLessThan(projection.height / 4);
    expect(html).toContain(">Casablanca</text>");
  });

  it("describes the position for screen readers and credits the data sources", () => {
    const html = render(casa);
    expect(html).toContain("Position approximative : Casablanca, Casablanca-Settat");
    expect(html).toContain("© <a href=\"https://www.openstreetmap.org/copyright\"");
    expect(html).toContain("OpenStreetMap contributors</a> · Protomaps");
    expect(html).toContain("geoBoundaries");
  });

  it("emits neither scripts nor inline styles (hash CSP), only classes and presentation attributes", () => {
    const html = render(casa);
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toContain("onclick");
  });

  it("renders Arabic names for the ar locale with a centred label", () => {
    const html = render({ ...casa, locale: "ar" }, "ar");
    expect(html).toContain("الدار البيضاء");
    expect(html).toContain("موقع تقريبي: الدار البيضاء، الدار البيضاء-سطات");
    expect(html).toContain('text-anchor="middle"');
  });

  it("highlights the given region when the city is unknown and still renders the map", () => {
    const html = render({ citySlug: "nowhere", seed: "x", locale: "fr", regionCode: "11" });
    expect(html).toContain('data-region="11" data-active="true"');
    expect(html).not.toContain("static-map-marker");
    expect(html).toContain("Carte des régions du Maroc");
  });

  it("keeps a southern city's label inside the map", () => {
    const html = render({ citySlug: "dakhla", seed: "abc12345", locale: "fr" });
    const { projection } = regionsSvg();
    const y = Number(attr(html, /<text[^>]*>/, "y"));
    const x = Number(attr(html, /<text[^>]*>/, "x"));
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThanOrEqual(projection.height);
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(projection.width);
  });
});
