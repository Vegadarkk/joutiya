import { approximatePosition, cityBySlug } from "@/config/regions";
import { moroccoClock } from "@/lib/appointments/time";
import { normalizeZone, type SearchZone } from "./params";
import type { SearchCard } from "./types";

// Map of the search page (Carte vivante, lot 2): where each result stands and what its pin says.
// Client-safe and pure. Privacy: a pin never sits on a real point, only at the listing page's own
// approximate position (approximatePosition(city, listing id): the city centroid moved 330 to 780 m
// in a direction drawn from the id), so the map tells no more than the listing page already does.

export interface LatLng {
  lat: number;
  lng: number;
}

/** Published (not bumped) on the current day in Morocco (Africa/Casablanca wall clock). */
export function isPublishedToday(card: Pick<SearchCard, "sortAt" | "bumped">, now: Date): boolean {
  if (card.bumped) return false;
  const at = Date.parse(card.sortAt);
  if (!Number.isFinite(at) || at > now.getTime()) return false;
  return moroccoClock(at).day === moroccoClock(now.getTime()).day;
}

/** The pin position of a result: its approximate position, or null without a known city. */
export function pinPosition(card: Pick<SearchCard, "id" | "citySlug">): LatLng | null {
  const city = card.citySlug ? cityBySlug(card.citySlug) : undefined;
  return city ? approximatePosition(city, card.id) : null;
}

export interface PinSource {
  id: string;
  position: LatLng;
  featured: boolean;
}

/**
 * The results of one page as pins: the À la Une cards first (drawn for this page), then the
 * organic ones; a listing appears once, and a result without a place has no pin.
 */
export function pinSources(featured: readonly SearchCard[], hits: readonly SearchCard[]): PinSource[] {
  const seen = new Set<string>();
  const pins: PinSource[] = [];
  for (const [card, isFeatured] of [...featured.map((card) => [card, true] as const), ...hits.map((card) => [card, false] as const)]) {
    if (seen.has(card.id)) continue;
    const position = pinPosition(card);
    if (!position) continue;
    seen.add(card.id);
    pins.push({ id: card.id, position, featured: isFeatured });
  }
  return pins;
}

/** South-west and north-east corners around the points, or null without any. */
export function boundsOf(points: readonly LatLng[]): { sw: LatLng; ne: LatLng } | null {
  if (points.length === 0) return null;
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const { lat, lng } of points) {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lng);
    east = Math.max(east, lng);
  }
  return { sw: { lat: south, lng: west }, ne: { lat: north, lng: east } };
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance, km. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * "Rechercher dans cette zone": the circle inscribed in the visible map (its centre and the middle
 * of each visible edge), so every result it finds can be seen; clamped and rounded like the URL.
 */
export function zoneFromView(center: LatLng, edges: readonly LatLng[]): SearchZone | undefined {
  if (edges.length === 0) return undefined;
  const km = Math.min(...edges.map((edge) => distanceKm(center, edge)));
  return normalizeZone({ lat: center.lat, lng: center.lng, km });
}
