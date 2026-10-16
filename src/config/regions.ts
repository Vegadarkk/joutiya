// Regions and cities of Morocco (phase 3, design §2). Data in ./geo/regions-data.ts (generated).
// Client-safe: the wizard's city picker and the listing page both import this file.

import type { Locale } from "@/config/site";
import { normalizeText } from "@/lib/text/normalize";
import { CITIES_DATA, REGIONS_DATA, type CityData, type RegionData } from "./geo/regions-data";

export type Region = RegionData;
export type City = CityData;

export const REGIONS: readonly Region[] = REGIONS_DATA;
export const CITIES: readonly City[] = CITIES_DATA;

/** Bounding box of the dataset and of the map extract (lng/lat), design D10. */
export const MOROCCO_BBOX = { west: -17.3, south: 20.7, east: -0.9, north: 36.1 } as const;

const regionsByCode = new Map(REGIONS.map((r) => [r.code, r]));
const citiesBySlug = new Map(CITIES.map((c) => [c.slug, c]));
const citiesByRegion = new Map<string, City[]>();
for (const city of CITIES) {
  const list = citiesByRegion.get(city.regionCode) ?? [];
  list.push(city);
  citiesByRegion.set(city.regionCode, list);
}

export const REGION_CODES: readonly string[] = REGIONS.map((r) => r.code);
export const CITY_SLUGS: readonly string[] = CITIES.map((c) => c.slug);

export function regionByCode(code: string): Region | undefined {
  return regionsByCode.get(code);
}

export function cityBySlug(slug: string): City | undefined {
  return citiesBySlug.get(slug);
}

/** Cities of a region: major cities first, then by population (stable on the dataset order). */
export function citiesOfRegion(regionCode: string): readonly City[] {
  const list = citiesByRegion.get(regionCode) ?? [];
  return [...list].sort(byMajorThenPopulation);
}

export function cityName(city: City, locale: Locale): string {
  return locale === "ar" ? city.nameAr : city.nameFr;
}

export function regionName(region: Region, locale: Locale): string {
  return locale === "ar" ? region.nameAr : region.nameFr;
}

function byMajorThenPopulation(a: City, b: City): number {
  if (a.major !== b.major) return a.major ? -1 : 1;
  return b.population - a.population;
}

interface SearchIndexEntry {
  city: City;
  fr: string;
  ar: string;
  region: string;
}

let searchIndex: SearchIndexEntry[] | undefined;
function index(): SearchIndexEntry[] {
  searchIndex ??= CITIES.map((city) => ({
    city,
    fr: normalizeText(city.nameFr),
    ar: normalizeText(city.nameAr),
    region: normalizeText(regionsByCode.get(city.regionCode)?.nameFr ?? ""),
  }));
  return searchIndex;
}

/**
 * Accent- and script-insensitive city search for the picker. Empty query: the major cities.
 * Ranking: word-start matches first, then any match, major cities and population as tie breakers.
 */
export function searchCities(query: string, locale: Locale, limit = 12): City[] {
  const q = normalizeText(query);
  if (!q) {
    return CITIES.filter((c) => c.major)
      .sort((a, b) => b.population - a.population)
      .slice(0, limit);
  }
  const scored: { city: City; score: number }[] = [];
  for (const entry of index()) {
    const names = locale === "ar" ? [entry.ar, entry.fr] : [entry.fr, entry.ar];
    let score = 0;
    for (const [i, name] of names.entries()) {
      if (name.startsWith(q)) score = Math.max(score, 100 - i * 10);
      else if (name.split(" ").some((w) => w.startsWith(q))) score = Math.max(score, 80 - i * 10);
      else if (name.includes(q)) score = Math.max(score, 50 - i * 10);
    }
    if (score === 0 && q.length >= 3 && entry.region.includes(q)) score = 20;
    if (score > 0) scored.push({ city: entry.city, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || byMajorThenPopulation(a.city, b.city))
    .slice(0, limit)
    .map((s) => s.city);
}

/** Deterministic position for an approximate marker: the city centroid shifted by at most ~700 m, from a seed. */
export function approximatePosition(city: City, seed: string): { lat: number; lng: number } {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  const angle = ((h & 0xffff) / 0xffff) * Math.PI * 2;
  const radius = 0.003 + (((h >>> 16) & 0xffff) / 0xffff) * 0.004; // degrees, ~330-780 m
  return {
    lat: Math.round((city.lat + Math.sin(angle) * radius) * 1e5) / 1e5,
    lng: Math.round((city.lng + (Math.cos(angle) * radius) / Math.cos((city.lat * Math.PI) / 180)) * 1e5) / 1e5,
  };
}
