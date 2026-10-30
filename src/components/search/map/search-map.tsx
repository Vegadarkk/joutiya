"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { Minus, Plus, ScanSearch } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { addProtocol, LngLatBounds, Map as MapLibreMap, Marker, setWorkerUrl, type GeoJSONSource, type MapGeoJSONFeature } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { cityBySlug, MOROCCO_BBOX, regionByCode } from "@/config/regions";
import { isRtl, type Locale } from "@/config/site";
import { buildSearchStyle, pinsCollection, PINS_SOURCE, SEARCH_ZOOM, type MapTheme } from "@/lib/map/search-style";
import { MAPLIBRE_WORKER_URL } from "@/lib/map/style";
import { supportsWebGL2 } from "@/lib/map/webgl";
import { boundsOf, coreBounds, zoneFromView } from "@/lib/search/map-pins";
import type { SearchZone } from "@/lib/search/params";
import type { MapListing } from "./map-listings";
import { mapPadding } from "./map-layout";
import { useSearchMap } from "./search-map-root";

// The map of the search page (Carte vivante, lot 2) and of the home page (lot 3): a lazy island
// (next/dynamic, ssr:false) that only loads in the map view, after the list has painted. Same
// self-hosted basemap and CSP rules as the listing page map (worker from our origin, PMTiles by
// Range requests, no glyphs or sprites). The results are HTML markers (real buttons: focus, Enter,
// screen-reader names) over a clustered GeoJSON source: price pills, a green dot on the ones
// published today, count bubbles where pins overlap. The few À la Une results stand apart as photo
// arches ringed in gold, never folded into a count (the home map shows the whole country).
// Positions are approximate only.

let protocolRegistered = false;
/** Listings a bubble fans out at the last zoom; past that many, the list panel is the way. */
const FAN_MAX = 12;

const themeOf = (): MapTheme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface PinLabels {
  pin: (listing: MapListing) => string;
  cluster: (count: number) => string;
}

function pinElement(listing: MapListing, label: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = listing.featured ? "search-pin search-pin-featured" : "search-pin";
  element.dataset.listingId = listing.id;
  if (listing.today) element.dataset.today = "";
  element.setAttribute("aria-label", label);
  if (listing.featured) {
    const frame = document.createElement("span");
    frame.className = "search-pin-photo";
    if (listing.photo) {
      const image = document.createElement("img");
      image.src = listing.photo.src;
      image.alt = "";
      image.decoding = "async";
      frame.append(image);
    }
    element.append(frame);
  }
  const price = document.createElement("span");
  price.className = "search-pin-price";
  price.textContent = listing.pin;
  element.append(price);
  return element;
}

/** The clustered source holds the organic results; the À la Une arches are placed on their own. */
const clustered = (listings: readonly MapListing[]) => pinsCollection(listings.filter((listing) => !listing.featured));

function clusterElement(count: number, label: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "search-cluster";
  element.dataset.size = count < 10 ? "s" : count < 50 ? "m" : "l";
  element.setAttribute("aria-label", label);
  element.textContent = String(count);
  return element;
}

/** The map's current padding, every side set. */
function paddingOf(instance: MapLibreMap) {
  const { top = 0, right = 0, bottom = 0, left = 0 } = instance.getPadding();
  return { top, right, bottom, left };
}

/** Breathing room around fitted results, inside the visible area. */
const FIT_MARGIN_PX = 48;

/** Circle of a zone as map bounds. */
function zoneBounds(zone: SearchZone): LngLatBounds {
  const dLat = zone.km / 111.32;
  const dLng = zone.km / (111.32 * Math.cos((zone.lat * Math.PI) / 180));
  return new LngLatBounds([zone.lng - dLng, zone.lat - dLat], [zone.lng + dLng, zone.lat + dLat]);
}

export interface SearchMapProps {
  onReady: () => void;
}

export default function SearchMap({ onReady }: SearchMapProps) {
  const state = useSearchMap();
  const t = useTranslations("SearchMap");
  const tMap = useTranslations("Map");
  const locale = useLocale() as Locale;
  const rtl = isRtl(locale);
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markers = useRef(new Map<string, { marker: Marker; element: HTMLButtonElement }>());
  // A count bubble opened at the last zoom: its listings fanned out around it.
  const fan = useRef<{ key: string; ids: string[] } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [moved, setMoved] = useState(false);

  // Everything the map callbacks read, current without recreating the map.
  const latest = useRef({ state, onReady, labels: null as PinLabels | null, rtl });
  const labels: PinLabels = {
    pin: (listing) =>
      [t("pin.label", { title: listing.title, price: listing.amount }), listing.example ? t("pin.example") : null, listing.featured ? t("pin.featured") : null, listing.today ? t("pin.today") : null].filter(Boolean).join(", "),
    cluster: (count) => t("pin.cluster", { count }),
  };
  useEffect(() => {
    latest.current = { state, onReady, labels, rtl };
  });

  const map = state?.map ?? null;
  const pmtilesUrl = map?.pmtilesUrl;
  const attribution = map?.attribution;

  // ---- The map itself, once.
  useEffect(() => {
    const element = container.current;
    if (!element || !pmtilesUrl) return;
    const fail = () => latest.current.state?.fail();
    if (!supportsWebGL2()) {
      fail();
      return;
    }
    setWorkerUrl(MAPLIBRE_WORKER_URL);
    if (!protocolRegistered) {
      addProtocol("pmtiles", new Protocol().tile);
      protocolRegistered = true;
    }
    const pins = clustered(latest.current.state?.listings ?? []);
    let ready = false;
    let failed = false;
    const instance = new MapLibreMap({
      container: element,
      style: buildSearchStyle(pmtilesUrl, { attribution, theme: themeOf(), pins }),
      bounds: [
        [MOROCCO_BBOX.west, MOROCCO_BBOX.south],
        [MOROCCO_BBOX.east, MOROCCO_BBOX.north],
      ],
      minZoom: SEARCH_ZOOM.min,
      maxZoom: SEARCH_ZOOM.max,
      maxBounds: [
        [MOROCCO_BBOX.west - 2, MOROCCO_BBOX.south - 2],
        [MOROCCO_BBOX.east + 2, MOROCCO_BBOX.north + 2],
      ],
      attributionControl: false,
      dragRotate: false,
      touchPitch: false,
      pitchWithRotate: false,
      fadeDuration: 0,
    });
    instance.touchZoomRotate.disableRotation();
    instance.keyboard.disableRotation();
    mapRef.current = instance;

    instance.once("load", () => {
      ready = true;
      setLoaded(true);
      latest.current.onReady();
    });
    instance.on("error", (event) => {
      if (ready || failed) return;
      failed = true;
      console.warn("search map unavailable", event.error?.message ?? "unknown error");
      fail();
    });
    instance.on("moveend", (event) => {
      if ("originalEvent" in event && event.originalEvent) setMoved(true);
    });

    // The basemap follows the site theme.
    const observer = new MutationObserver(() => {
      if (!ready) return;
      const current = (instance.getSource(PINS_SOURCE) as GeoJSONSource | undefined)?.serialize().data;
      instance.setStyle(buildSearchStyle(pmtilesUrl, { attribution, theme: themeOf(), pins: (current as ReturnType<typeof pinsCollection>) ?? clustered(latest.current.state?.listings ?? []) }), { diff: true });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const markerMap = markers.current;
    return () => {
      observer.disconnect();
      for (const { marker } of markerMap.values()) marker.remove();
      markerMap.clear();
      mapRef.current = null;
      instance.remove();
    };
  }, [pmtilesUrl, attribution]);

  // ---- Markers: HTML pins for the points and clusters the source shows at this zoom.
  useEffect(() => {
    const instance = mapRef.current;
    if (!instance || !loaded) return;
    const byId = new Map((state?.listings ?? []).map((listing) => [listing.id, listing]));

    function sync() {
      if (!instance) return;
      const seen = new Set<string>();
      const features = [
        ...(instance.querySourceFeatures(PINS_SOURCE) as MapGeoJSONFeature[]),
        // À la Une: always their own arch, at every zoom.
        ...[...byId.values()]
          .filter((listing) => listing.featured)
          .map((listing) => ({ geometry: { type: "Point" as const, coordinates: [listing.position.lng, listing.position.lat] }, properties: { id: listing.id } })),
      ];
      // A marker: the button in a holder, at a spot, moved by a pixel offset when fanned out of a bubble.
      // MapLibre places the marker with `transform`: a `scale` on that same element would scale its
      // offset too (the pin leaps away from the pointer, then back). The pin grows inside a holder.
      const place = (key: string, element: HTMLButtonElement, at: [number, number], anchor: "center" | "bottom", offset: [number, number] = [0, 0]) => {
        const holder = document.createElement("div");
        holder.className = "search-marker";
        holder.append(element);
        const marker = new Marker({ element: holder, anchor, offset }).setLngLat(at).addTo(instance);
        markers.current.set(key, { marker, element });
      };
      const pinFor = (listing: MapListing): HTMLButtonElement => {
        const key = listing.id;
        const element = pinElement(listing, latest.current.labels?.pin(listing) ?? listing.title);
        element.addEventListener("pointerenter", () => latest.current.state?.highlight(key));
        element.addEventListener("pointerleave", () => latest.current.state?.highlight(null));
        element.addEventListener("focus", () => latest.current.state?.highlight(key));
        element.addEventListener("blur", () => latest.current.state?.highlight(null));
        element.addEventListener("click", (event) => {
          event.stopPropagation();
          const current = latest.current.state;
          if (!current) return;
          if (current.desktop) {
            current.select(key, element);
            return;
          }
          // Phones: the sheet comes up to the row.
          current.highlight(key);
          if (current.snap === "peek") current.setSnap("half");
          window.setTimeout(() => {
            document.querySelector(`[data-map-row][data-listing-id="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
          }, 320);
        });
        return element;
      };
      for (const feature of features) {
        if (feature.geometry.type !== "Point") continue;
        const [lng, lat] = feature.geometry.coordinates as [number, number];
        const props = feature.properties as { cluster?: boolean; cluster_id?: number; point_count?: number; id?: string };
        const key = props.cluster ? `cluster:${props.cluster_id}` : (props.id ?? "");
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (!props.cluster) {
          if (markers.current.has(key)) continue;
          const listing = byId.get(key);
          if (!listing) continue;
          place(key, pinFor(listing), [lng, lat], listing.featured ? "bottom" : "center");
          continue;
        }
        const count = props.point_count ?? 0;
        const clusterId = props.cluster_id ?? 0;
        const open = fan.current?.key === key;
        if (open) {
          // The bubble's listings on a ring around it, each its usual pin.
          const leaves = fan.current!.ids.map((id) => byId.get(id)).filter((listing): listing is MapListing => Boolean(listing));
          const radius = Math.max(48, (leaves.length * 72) / (2 * Math.PI));
          leaves.forEach((listing, index) => {
            const leafKey = `fan:${listing.id}`;
            seen.add(leafKey);
            if (markers.current.has(leafKey)) return;
            const angle = -Math.PI / 2 + (2 * Math.PI * index) / leaves.length;
            place(leafKey, pinFor(listing), [lng, lat], "center", [Math.round(radius * Math.cos(angle)), Math.round(radius * Math.sin(angle))]);
          });
        }
        const existing = markers.current.get(key);
        if (existing) {
          existing.element.toggleAttribute("data-open", open);
          continue;
        }
        const element = clusterElement(count, latest.current.labels?.cluster(count) ?? String(count));
        element.toggleAttribute("data-open", open);
        element.addEventListener("click", (event) => {
          event.stopPropagation();
          const source = instance.getSource(PINS_SOURCE) as GeoJSONSource | undefined;
          if (!source) return;
          source.getClusterExpansionZoom(clusterId).then(
            async (zoom) => {
              // The bubble splits at a zoom the map reaches: go there.
              if (zoom <= SEARCH_ZOOM.clusterMax || instance.getZoom() < SEARCH_ZOOM.max - 0.05) {
                instance.easeTo({ center: [lng, lat], zoom: Math.min(zoom + 0.2, SEARCH_ZOOM.max), duration: reducedMotion() ? 0 : 500 });
                setMoved(true);
                return;
              }
              // At the last zoom it never splits (neighbours a few hundred metres apart, positions
              // approximate): its listings fan out around it; a second click folds them back.
              if (fan.current?.key === key) fan.current = null;
              else {
                const leaves = await source.getClusterLeaves(clusterId, FAN_MAX, 0);
                fan.current = { key, ids: leaves.map((leaf) => String(leaf.properties?.id ?? "")).filter(Boolean) };
              }
              sync();
            },
            () => undefined,
          );
        });
        place(key, element, [lng, lat], "center");
      }
      // The bubble a fan belonged to is gone (zoom, new results): so is the fan.
      if (fan.current && !seen.has(fan.current.key)) fan.current = null;
      for (const [key, { marker }] of markers.current) {
        if (seen.has(key)) continue;
        marker.remove();
        markers.current.delete(key);
      }
      lift();
      mark();
    }

    // An À la Une arch is never clustered: standing on the same spot as a count bubble, a price pill
    // or another arch (listings share their city's rounded centre), it would hide it. The arch then
    // moves the shortest way clear (up or aside, a few steps at most) and comes back once the map
    // moves them apart.
    function lift() {
      if (!instance) return;
      type Box = { left: number; right: number; top: number; bottom: number };
      const obstacles: Box[] = [...markers.current.values()]
        .filter(({ element }) => !element.classList.contains("search-pin-featured"))
        .map(({ marker, element }) => {
          const at = instance.project(marker.getLngLat()).add(marker.getOffset());
          const halfWidth = element.offsetWidth / 2;
          const halfHeight = element.offsetHeight / 2;
          return { left: at.x - halfWidth, right: at.x + halfWidth, top: at.y - halfHeight, bottom: at.y + halfHeight };
        });
      for (const { marker, element } of markers.current.values()) {
        if (!element.classList.contains("search-pin-featured")) continue;
        const at = instance.project(marker.getLngLat());
        const width = element.offsetWidth;
        const height = element.offsetHeight;
        let dx = 0;
        let dy = 0;
        const box = (): Box => ({ left: at.x + dx - width / 2, right: at.x + dx + width / 2, top: at.y + dy - height, bottom: at.y + dy });
        for (let step = 0; step < 8; step += 1) {
          const current = box();
          const hit = obstacles.find((o) => current.left < o.right && o.left < current.right && current.top < o.bottom && o.top < current.bottom);
          if (!hit) break;
          const up = hit.top - 4 - at.y;
          const aside = at.x + dx >= (hit.left + hit.right) / 2 ? hit.right + 4 - (at.x - width / 2) : hit.left - 4 - (at.x + width / 2);
          if (Math.abs(up - dy) <= Math.abs(aside - dx)) dy = up;
          else dx = aside;
        }
        obstacles.push(box());
        const offset = marker.getOffset();
        if (offset.x !== dx || offset.y !== dy) marker.setOffset([dx, dy]);
      }
    }

    const onData = (event: { sourceId?: string; isSourceLoaded?: boolean }) => {
      if (event.sourceId === PINS_SOURCE && event.isSourceLoaded) sync();
    };
    // A click on the map itself folds an open fan (the markers stop their own clicks).
    const onMapClick = () => {
      if (!fan.current) return;
      fan.current = null;
      sync();
    };
    instance.on("move", sync);
    instance.on("moveend", sync);
    instance.on("sourcedata", onData);
    instance.on("click", onMapClick);
    sync();
    return () => {
      instance.off("move", sync);
      instance.off("moveend", sync);
      instance.off("sourcedata", onData);
      instance.off("click", onMapClick);
    };
  }, [loaded, state?.listings]);

  // ---- New results: new data, a fresh framing, no "search this zone" until the next move.
  const ids = state?.listings.map((listing) => listing.id).join(",") ?? "";
  const zone = state?.params.zone;
  const zoneKey = zone ? `${zone.lat},${zone.lng},${zone.km}` : "";
  const city = state?.params.city;
  const region = state?.params.region;
  const first = useRef(true);
  useEffect(() => {
    const instance = mapRef.current;
    if (!instance || !loaded) return;
    const listings = latest.current.state?.listings ?? [];
    const source = instance.getSource(PINS_SOURCE) as GeoJSONSource | undefined;
    for (const { marker } of markers.current.values()) marker.remove();
    markers.current.clear();
    fan.current = null;
    source?.setData(clustered(listings));
    setMoved(false);
    const animate = !first.current && !reducedMotion();
    first.current = false;
    // Fit inside the room the panels leave (fitBounds adds its padding to the map's own).
    const current = latest.current.state;
    const wide = current?.desktop ?? true;
    instance.setPadding(
      mapPadding({
        desktop: wide,
        rtl: latest.current.rtl,
        collapsed: current?.collapsed ?? false,
        detail: wide && Boolean(current?.selected),
        snap: current?.snap ?? "peek",
        viewportHeight: window.innerHeight,
      }),
    );
    const options = { maxZoom: SEARCH_ZOOM.fit, duration: animate ? 700 : 0, padding: FIT_MARGIN_PX };
    if (zone) {
      // The searched circle fills the visible room again: no drift on repeated "search this zone".
      instance.fitBounds(zoneBounds(zone), { ...options, maxZoom: SEARCH_ZOOM.max, padding: 0 });
      return;
    }
    // The home page frames where most listings stand; a search shows every result.
    const points = listings.map((listing) => listing.position);
    const box = current?.variant === "home" ? coreBounds(points) : boundsOf(points);
    if (box) {
      instance.fitBounds(new LngLatBounds([box.sw.lng, box.sw.lat], [box.ne.lng, box.ne.lat]), options);
      return;
    }
    const place = city ? cityBySlug(city) : undefined;
    if (place) {
      instance.easeTo({ center: [place.lng, place.lat], zoom: SEARCH_ZOOM.city, duration: options.duration });
      return;
    }
    const area = region ? regionByCode(region) : undefined;
    if (area) {
      instance.easeTo({ center: [area.centroid.lng, area.centroid.lat], zoom: 7, duration: options.duration });
      return;
    }
    instance.fitBounds(
      [
        [MOROCCO_BBOX.west, MOROCCO_BBOX.south],
        [MOROCCO_BBOX.east, MOROCCO_BBOX.north],
      ],
      { duration: options.duration, padding: FIT_MARGIN_PX },
    );
    // Framing depends on the result ids and the zone, not on the objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, ids, zoneKey]);

  // ---- The visible room left by the panels, sheet and toolbar.
  const desktop = state?.desktop ?? true;
  const collapsed = state?.collapsed ?? false;
  const detail = state?.selected !== null && state?.selected !== undefined && desktop;
  const snap = state?.snap ?? "peek";
  useEffect(() => {
    const instance = mapRef.current;
    if (!instance || !loaded) return;
    const padding = mapPadding({ desktop, rtl, collapsed, detail, snap, viewportHeight: window.innerHeight });
    instance.easeTo({ padding, duration: reducedMotion() ? 0 : 300 });
  }, [loaded, desktop, rtl, collapsed, detail, snap]);

  // ---- The pin under the pointer and the open one.
  const highlighted = state?.highlighted ?? null;
  const selected = state?.selected ?? null;
  const marks = useRef({ highlighted, selected });
  function mark() {
    const { highlighted: lit, selected: open } = marks.current;
    for (const [key, { element }] of markers.current) {
      const value = key === open ? "selected" : key === lit ? "highlight" : undefined;
      if (value) element.dataset.state = value;
      else delete element.dataset.state;
      const wrapper = element.closest<HTMLElement>(".search-marker") ?? element;
      wrapper.style.zIndex = value ? "3" : element.classList.contains("search-pin-featured") ? "2" : "";
    }
  }
  useEffect(() => {
    marks.current = { highlighted, selected };
    mark();
  }, [highlighted, selected]);

  // A pin opened from the list, hidden behind a panel or off screen, comes into view.
  useEffect(() => {
    const instance = mapRef.current;
    if (!instance || !loaded || !selected) return;
    const listing = state?.listings.find((item) => item.id === selected);
    if (!listing) return;
    const point = instance.project([listing.position.lng, listing.position.lat]);
    const { width, height } = instance.getContainer().getBoundingClientRect();
    const padding = paddingOf(instance);
    const inside = point.x > padding.left && point.x < width - padding.right && point.y > padding.top && point.y < height - padding.bottom;
    if (!inside) instance.easeTo({ center: [listing.position.lng, listing.position.lat], duration: reducedMotion() ? 0 : 500 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, selected]);

  function searchHere() {
    const instance = mapRef.current;
    if (!instance || !state) return;
    const { width, height } = instance.getContainer().getBoundingClientRect();
    const padding = paddingOf(instance);
    const cx = padding.left + (width - padding.left - padding.right) / 2;
    const cy = padding.top + (height - padding.top - padding.bottom) / 2;
    const point = (x: number, y: number) => {
      const at = instance.unproject([x, y]);
      return { lat: at.lat, lng: at.lng };
    };
    const zoneValue = zoneFromView(point(cx, cy), [point(padding.left, cy), point(width - padding.right, cy), point(cx, padding.top), point(cx, height - padding.bottom)]);
    if (!zoneValue) return;
    setMoved(false);
    state.searchZone(zoneValue);
  }

  function zoom(by: 1 | -1) {
    const instance = mapRef.current;
    if (!instance) return;
    if (by > 0) instance.zoomIn({ duration: reducedMotion() ? 0 : 250 });
    else instance.zoomOut({ duration: reducedMotion() ? 0 : 250 });
    setMoved(true);
  }

  return (
    <>
      {/* maplibre-gl.css (unlayered) sets `position: relative` on the map element: the wrapper places it. */}
      <div className="absolute inset-0">
        <div ref={container} data-testid="search-map" role="region" aria-label={t("mapLabel")} className="size-full" />
      </div>
      {loaded && moved ? (
        <div className="search-zone-slot">
          <button type="button" data-testid="search-zone" onClick={searchHere} className="search-zone-button">
            <ScanSearch className="size-4" aria-hidden="true" />
            {t("zoneButton")}
          </button>
        </div>
      ) : null}
      {loaded ? (
        <div className="search-zoom max-lg:hidden">
          <button type="button" onClick={() => zoom(1)} aria-label={tMap("zoomIn")} className="search-zoom-button float-card">
            <Plus className="size-5" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => zoom(-1)} aria-label={tMap("zoomOut")} className="search-zoom-button float-card">
            <Minus className="size-5" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </>
  );
}
