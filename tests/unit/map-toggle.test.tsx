import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import fr from "../../messages/fr.json";

// The button that loads the interactive map is a 44 px touch target on phones (h-11 below sm),
// like the other controls of the listing page; it keeps the compact h-9 from sm up.

// The server snapshot of useSyncExternalStore is always false (no WebGL2 on the server): render
// the browser snapshot instead, as after hydration.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof React>();
  return { ...actual, useSyncExternalStore: <T,>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot() };
});
vi.mock("@/lib/map/webgl", () => ({ supportsWebGL2: () => true }));
vi.mock("@/lib/config/client", () => ({
  usePublicConfig: () => ({ map: { pmtilesUrl: "https://media.joutiya.test/maroc.pmtiles", attribution: "© OpenStreetMap" } }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

const { MapToggle } = await import("@/components/map/map-toggle");

describe("MapToggle", () => {
  it("renders the toggle as a 44 px target on phones", () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="fr" messages={fr} timeZone="Africa/Casablanca">
        <MapToggle center={{ lng: -7.6, lat: 33.6 }} description="Position approximative : Casablanca, Casablanca-Settat">
          <div data-testid="static-map" />
        </MapToggle>
      </NextIntlClientProvider>,
    );
    const classes = /<button[^>]*class="([^"]*)"[^>]*data-testid="map-toggle"/.exec(html)?.[1]?.split(" ") ?? [];
    expect(classes).toContain("max-sm:h-11");
    expect(classes).toContain("h-9");
  });
});
