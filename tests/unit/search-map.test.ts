import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { approximatePosition, cityBySlug, MOROCCO_BBOX } from "@/config/regions";
import { buildMapListings, pinAmount, type MapListingLabels } from "@/components/search/map/map-listings";
import { mapPadding, DETAIL_PX, PANEL_PX } from "@/components/search/map/map-layout";
import { dragHeight, settleSnap, sheetHeights, SHEET_PEEK_PX, stepSnap } from "@/components/search/map/sheet";
import { initialView, mapPossible, slowConnection } from "@/components/search/map/view-mode";
import { CLUSTER_RADIUS_PX, HALO_LAYER, PINS_SOURCE, SEARCH_ZOOM, buildSearchStyle, pinsCollection } from "@/lib/map/search-style";
import { HOUSE_LAYERS, REGIONS_SOURCE, buildHouseStyle } from "@/lib/map/style";
import { boundsOf, coreBounds, distanceKm, isPublishedToday, pinPosition, pinSources, zoneFromView } from "@/lib/search/map-pins";
import {
  ZONE_KM_MAX,
  canonicalSearchParams,
  formatZone,
  parseSearchParams,
  parseZone,
  searchPath,
  storedSearchParamsSchema,
} from "@/lib/search/params";
import type { SearchCard } from "@/lib/search/types";
import { moroccoTime } from "@/lib/appointments/time";

// Map-first search (Carte vivante, lot 2): the `zone` URL parameter, the pins (approximate
// positions, "published today"), the phone sheet's heights, the starting view, the map padding and
// the search style.

const casablanca = cityBySlug("casablanca")!;
const rabat = cityBySlug("rabat")!;

function card(id: string, overrides: Partial<SearchCard> = {}): SearchCard {
  return {
    id,
    slugId: `velo-${id}`,
    title: `Vélo ${id}`,
    subcategoryId: "velos",
    price: 1500,
    priceNegotiable: false,
    isDonation: false,
    citySlug: "casablanca",
    photo: null,
    photoCount: 0,
    sellerType: "individual",
    sortAt: "2026-10-16T10:00:00.000Z",
    bumped: false,
    featured: false,
    ...overrides,
  };
}

describe("zone URL parameter", () => {
  it("parses lat,lng,km, rounds to 3 decimals and rounds the radius up", () => {
    expect(parseZone("33.57314,-7.58982,12.2")).toEqual({ lat: 33.573, lng: -7.59, km: 13 });
    expect(parseZone(" 34.02,-6.84,8 ")).toEqual({ lat: 34.02, lng: -6.84, km: 8 });
  });

  it("clamps the centre to Morocco and the radius to 1..200 km", () => {
    expect(parseZone("48.85,2.35,500")).toEqual({ lat: MOROCCO_BBOX.north, lng: MOROCCO_BBOX.east, km: ZONE_KM_MAX });
    expect(parseZone("-10,-40,0")).toEqual({ lat: MOROCCO_BBOX.south, lng: MOROCCO_BBOX.west, km: 1 });
  });

  it("drops malformed values", () => {
    for (const value of ["", "abc", "33.5,-7.5", "33.5,-7.5,-3", "1e3,0,5", "33.5;-7.5;3", "33.5,-7.5,3,4", "1234,-7.5,3", "33.5,-7.5,123456"]) {
      expect(parseZone(value), value).toBeUndefined();
    }
    expect(parseSearchParams(new URLSearchParams("zone=nope&q=velo"))).toEqual({ q: "velo" });
  });

  it("replaces the city, region, radius and district, and keeps the distance sort", () => {
    const params = parseSearchParams(new URLSearchParams("zone=33.5731,-7.5898,12&ville=casablanca&region=CS&rayon=20&quartier=maarif&tri=distance&categorie=vehicules"));
    expect(params).toEqual({ zone: { lat: 33.573, lng: -7.59, km: 12 }, sort: "distance", category: "vehicules" });
    expect(searchPath(params)).toBe("/recherche?categorie=vehicules&zone=33.573%2C-7.59%2C12&tri=distance");
    expect(parseSearchParams(new URL(`https://x.test${searchPath(params)}`).searchParams)).toEqual(params);
    expect(formatZone({ lat: 33.573, lng: -7.59, km: 12 })).toBe("33.573,-7.59,12");
  });

  it("opens the search page on the zone alone from the home page's map (lot 3: no filter there)", () => {
    const zone = { lat: 33.57312, lng: -7.58981, km: 41.2 };
    expect(searchPath(canonicalSearchParams({ zone, page: undefined }))).toBe("/recherche?zone=33.573%2C-7.59%2C42");
  });

  it("normalises a zone set in code, and drops one that is not finite", () => {
    expect(canonicalSearchParams({ zone: { lat: 40, lng: -7.123456, km: 0.2 } }).zone).toEqual({ lat: MOROCCO_BBOX.north, lng: -7.123, km: 1 });
    expect(canonicalSearchParams({ zone: { lat: Number.NaN, lng: -7, km: 5 }, city: "rabat" })).toEqual({ city: "rabat", region: rabat.regionCode });
  });

  it("is a strict, bounded object in a saved search", () => {
    expect(storedSearchParamsSchema.safeParse({ zone: { lat: 33.573, lng: -7.59, km: 12 } }).success).toBe(true);
    expect(storedSearchParamsSchema.safeParse({ zone: { lat: 33.573, lng: -7.59, km: 500 } }).success).toBe(false);
    expect(storedSearchParamsSchema.safeParse({ zone: { lat: 33.573, lng: -7.59, km: 12, extra: 1 } }).success).toBe(false);
    expect(storedSearchParamsSchema.safeParse({ zone: { lat: 60, lng: -7.59, km: 12 } }).success).toBe(false);
  });
});

describe("published today (Morocco time)", () => {
  // Wall-clock times in Morocco, whatever its offset on these dates.
  const at = (day: string, hour: number, minute = 0) => new Date(moroccoTime(day, hour * 60 + minute)).toISOString();
  const now = new Date(moroccoTime("2026-10-29", 11 * 60));

  it("compares the Africa/Casablanca calendar day", () => {
    expect(isPublishedToday({ sortAt: at("2026-10-29", 8), bumped: false }, now)).toBe(true);
    expect(isPublishedToday({ sortAt: at("2026-10-29", 0, 10), bumped: false }, now)).toBe(true);
    expect(isPublishedToday({ sortAt: at("2026-10-28", 23, 50), bumped: false }, now)).toBe(false);
  });

  it("never marks a bumped listing, a future date or a broken one", () => {
    expect(isPublishedToday({ sortAt: at("2026-10-29", 8), bumped: true }, now)).toBe(false);
    expect(isPublishedToday({ sortAt: at("2026-10-29", 12), bumped: false }, now)).toBe(false);
    expect(isPublishedToday({ sortAt: "not a date", bumped: false }, now)).toBe(false);
  });
});

describe("pins", () => {
  it("sit at the listing page's approximate position, never at the city centre", () => {
    const position = pinPosition({ id: "aaaa2345", citySlug: "casablanca" });
    expect(position).toEqual(approximatePosition(casablanca, "aaaa2345"));
    expect(position).not.toEqual({ lat: casablanca.lat, lng: casablanca.lng });
    const offset = distanceKm(position!, casablanca);
    expect(offset).toBeGreaterThan(0.3);
    expect(offset).toBeLessThan(0.8);
    expect(pinPosition({ id: "aaaa2345", citySlug: null })).toBeNull();
    expect(pinPosition({ id: "aaaa2345", citySlug: "atlantis" })).toBeNull();
  });

  it("put À la Une first, once each, and skip results without a place", () => {
    const pins = pinSources(
      [card("ffff2345", { featured: true }), card("aaaa2345", { featured: true })],
      [card("aaaa2345"), card("bbbb2345", { citySlug: null }), card("cccc2345", { citySlug: "rabat" })],
    );
    expect(pins.map((pin) => [pin.id, pin.featured])).toEqual([
      ["ffff2345", true],
      ["aaaa2345", true],
      ["cccc2345", false],
    ]);
    expect(pins[2]?.position).toEqual(approximatePosition(rabat, "cccc2345"));
  });

  it("frame on the home page where most listings stand, leaving a far outlier out from 10 points", () => {
    const north = Array.from({ length: 20 }, (_, index) => ({ lat: 33 + index * 0.1, lng: -7 + index * 0.05 }));
    const dakhla = { lat: 23.7167, lng: -15.95 };
    const core = coreBounds([...north, dakhla]);
    expect(core?.sw.lat).toBeCloseTo(33);
    expect(core?.sw.lng).toBeCloseTo(-7);
    expect(core?.ne.lat).toBeCloseTo(34.8);
    expect(boundsOf([...north, dakhla])?.sw).toEqual(dakhla);
    // Few listings: every one of them.
    expect(coreBounds([...north.slice(0, 5), dakhla])).toEqual(boundsOf([...north.slice(0, 5), dakhla]));
    expect(coreBounds([])).toBeNull();
  });

  it("frame their bounds and turn the visible map into its inscribed zone", () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([casablanca, rabat])).toEqual({ sw: { lat: casablanca.lat, lng: casablanca.lng }, ne: { lat: rabat.lat, lng: rabat.lng } });
    const center = { lat: 33.6, lng: -7.6 };
    const edges = [
      { lat: 33.7, lng: -7.6 },
      { lat: 33.6, lng: -7.4 },
      { lat: 33.5, lng: -7.6 },
      { lat: 33.6, lng: -7.8 },
    ];
    // The nearest edge (north/south, ~11.1 km) bounds the circle, rounded up.
    expect(zoneFromView(center, edges)).toEqual({ lat: 33.6, lng: -7.6, km: 12 });
    expect(zoneFromView(center, [])).toBeUndefined();
    expect(zoneFromView(center, [{ lat: 10, lng: -7.6 }])?.km).toBe(ZONE_KM_MAX);
  });

  it("collect into one GeoJSON source, [lng, lat], with the À la Une weight", () => {
    const collection = pinsCollection([{ id: "a", position: { lat: 33.5, lng: -7.6 }, featured: true }]);
    expect(collection.features).toEqual([{ type: "Feature", properties: { id: "a", featured: 1 }, geometry: { type: "Point", coordinates: [-7.6, 33.5] } }]);
  });
});

describe("map listings (server formatting)", () => {
  const labels: MapListingLabels = {
    donation: "Don",
    toDiscuss: "Prix à discuter",
    today: "Aujourd'hui",
    per: (unit) => `par ${unit}`,
    pinPer: (unit) => `/${unit}`,
    fact: (id, count) => (id === "surface" ? `${count} m²` : null),
  };

  it("shortens the pin price: grouped digits, compact from a million", () => {
    expect(pinAmount(1500, "fr")).toMatch(/^1\s500$/);
    expect(pinAmount(0, "fr")).toBe("0");
    expect(pinAmount(950_000, "ar")).toMatch(/^950\s000$/);
    expect(pinAmount(1_250_000, "fr")).toMatch(/^1,3\sM$/);
  });

  it("formats each result once, with only the card's own fields", () => {
    const now = new Date(moroccoTime("2026-10-29", 11 * 60));
    const listings = buildMapListings({
      featured: [card("ffff2345", { featured: true })],
      hits: [
        card("aaaa2345", { sortAt: new Date(moroccoTime("2026-10-29", 8 * 60)).toISOString(), sellerType: "pro" }),
        card("bbbb2345", { isDonation: true, price: null }),
        card("cccc2345", { price: null, citySlug: null }),
      ],
      locale: "fr",
      media: null,
      now,
      labels,
    });
    expect(listings.map((listing) => listing.id)).toEqual(["ffff2345", "aaaa2345", "bbbb2345"]);
    const [featured, today, donation] = listings;
    expect(featured).toMatchObject({ featured: true, today: false, place: "Casablanca", photo: null });
    expect(featured?.pin).toMatch(/^1\s500$/);
    expect(featured?.amount).toMatch(/^1\s500\sDH$/);
    expect(today).toMatchObject({ featured: false, today: true, date: "Aujourd'hui", pro: true });
    expect(donation).toMatchObject({ amount: "Don", pin: "Don", negotiable: false });
    expect(Object.keys(featured!).sort()).toEqual(
      ["amount", "bumped", "date", "dateTime", "example", "exclusive", "facts", "featured", "id", "negotiable", "photo", "photoCount", "pin", "place", "position", "pro", "slugId", "title", "today"].sort(),
    );
  });
});

describe("phone sheet", () => {
  const heights = sheetHeights(844, 72);

  it("has three increasing heights for the viewport", () => {
    expect(heights).toEqual({ peek: SHEET_PEEK_PX, half: 422, full: 772 });
    const tiny = sheetHeights(200, 72);
    expect(tiny.peek).toBeLessThan(tiny.half);
    expect(tiny.half).toBeLessThan(tiny.full);
  });

  it("steps one height with the buttons and the arrow keys, staying at the ends", () => {
    expect(stepSnap("peek", 1)).toBe("half");
    expect(stepSnap("half", 1)).toBe("full");
    expect(stepSnap("full", 1)).toBe("full");
    expect(stepSnap("half", -1)).toBe("peek");
    expect(stepSnap("peek", -1)).toBe("peek");
  });

  it("settles a slow release on the nearest height and a flick on the next one", () => {
    expect(settleSnap(300, 0, heights)).toBe("half");
    expect(settleSnap(200, 0.1, heights)).toBe("peek");
    expect(settleSnap(700, -0.1, heights)).toBe("full");
    expect(settleSnap(200, 0.6, heights)).toBe("half");
    expect(settleSnap(430, 0.6, heights)).toBe("full");
    expect(settleSnap(420, -0.6, heights)).toBe("peek");
    expect(settleSnap(900, 0.6, heights)).toBe("full");
    expect(settleSnap(100, -0.6, heights)).toBe("peek");
  });

  it("gives a little past either end while dragging", () => {
    expect(dragHeight(300, 50, heights)).toBe(350);
    expect(dragHeight(heights.peek, -40, heights)).toBe(heights.peek - 10);
    expect(dragHeight(heights.full, 40, heights)).toBe(heights.full + 10);
  });
});

describe("starting view", () => {
  it("is the map when a basemap is configured and WebGL2 works", () => {
    expect(initialView({ hasMap: true, webgl2: true })).toBe("map");
    expect(initialView({ hasMap: false, webgl2: true, stored: "map" })).toBe("list");
    expect(initialView({ hasMap: true, webgl2: false, stored: "map" })).toBe("list");
    expect(mapPossible({ hasMap: true, webgl2: true })).toBe(true);
  });

  it("is the list on Save-Data or a 2G link, unless the visitor chose", () => {
    expect(initialView({ hasMap: true, webgl2: true, saveData: true })).toBe("list");
    expect(initialView({ hasMap: true, webgl2: true, effectiveType: "slow-2g" })).toBe("list");
    expect(initialView({ hasMap: true, webgl2: true, effectiveType: "2g" })).toBe("list");
    expect(initialView({ hasMap: true, webgl2: true, effectiveType: "3g" })).toBe("map");
    expect(initialView({ hasMap: true, webgl2: true, saveData: true, stored: "map" })).toBe("map");
    expect(initialView({ hasMap: true, webgl2: true, stored: "list" })).toBe("list");
    expect(initialView({ hasMap: true, webgl2: true, stored: "grid" })).toBe("map");
    expect(slowConnection({})).toBe(false);
  });
});

describe("map padding", () => {
  const base = { desktop: true, rtl: false, collapsed: false, detail: false, snap: "peek" as const, viewportHeight: 800 };

  it("leaves the list panel and the detail panel out of the framing, mirrored in Arabic", () => {
    expect(mapPadding(base)).toEqual({ top: 140, bottom: 72, left: PANEL_PX + 32, right: 64 });
    expect(mapPadding({ ...base, rtl: true })).toEqual({ top: 140, bottom: 72, left: 64, right: PANEL_PX + 32 });
    expect(mapPadding({ ...base, detail: true }).right).toBe(DETAIL_PX + 32);
    expect(mapPadding({ ...base, collapsed: true }).left).toBe(32);
  });

  it("keeps the phone map above the sheet", () => {
    const phone = { ...base, desktop: false, viewportHeight: 844 };
    expect(mapPadding(phone).bottom).toBe(SHEET_PEEK_PX + 16);
    expect(mapPadding({ ...phone, snap: "half" }).bottom).toBe(422 + 16);
    expect(mapPadding({ ...phone, snap: "full" }).bottom).toBe(422 + 16);
  });
});

describe("paid placement on the map (DSA)", () => {
  it("names an À la Une pin and its legend with the cards' own sponsored mention", () => {
    for (const messages of [fr, ar]) {
      expect(messages.SearchMap.pin.featured).toBe(messages.ListingCard.featured);
      expect(messages.SearchMap.legend.featured).toBe(messages.ListingCard.featured);
    }
    expect(fr.SearchMap.pin.featured).toBe("À la Une · Sponsorisé");
    expect(ar.SearchMap.pin.featured).toBe("في الواجهة · مُموَّل");
  });
});

describe("search map style", () => {
  const style = buildSearchStyle("https://media.joutiya.test/maps/morocco.pmtiles", { theme: "light", pins: pinsCollection([]) });

  it("draws no administrative boundary: neither our regions nor the tiles' lines", () => {
    expect(style.sources[REGIONS_SOURCE]).toBeUndefined();
    const ids = style.layers.map((layer) => layer.id);
    expect(ids).not.toContain(HOUSE_LAYERS.regions);
    expect(ids.filter((id) => /boundar/.test(id))).toEqual([]);
    expect(buildHouseStyle("https://media.joutiya.test/maps/morocco.pmtiles").sources[REGIONS_SOURCE]).toBeDefined();
  });

  it("clusters the pins in one source, with a halo above the basemap", () => {
    const source = style.sources[PINS_SOURCE];
    expect(source).toMatchObject({ type: "geojson", cluster: true, clusterRadius: CLUSTER_RADIUS_PX, clusterMaxZoom: SEARCH_ZOOM.clusterMax });
    expect(style.layers.at(-1)?.id).toBe(HALO_LAYER);
    const dark = buildSearchStyle("https://media.joutiya.test/maps/morocco.pmtiles", { theme: "dark", pins: pinsCollection([]) });
    expect(JSON.stringify(dark.layers)).not.toBe(JSON.stringify(style.layers));
  });
});
