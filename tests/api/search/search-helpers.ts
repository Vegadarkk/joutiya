import { NextRequest } from "next/server";
import { cityBySlug } from "@/config/regions";
import { GET } from "@/app/api/search/route";
import { setSearchEngineForTests } from "@/lib/search/engine";
import { MemoryEngine } from "@/lib/search/memory";
import { sitemapShardOf, type SearchDocument } from "@/lib/search/types";
import { Jar, ORIGIN, type ErrorBody } from "../auth/helpers";

// Plumbing of the /api/search tests: index documents built by hand (no Firestore listing, no
// indexer), served by the memory engine (production synonyms by default), and a GET helper that keeps
// the device and pass cookies in a jar like a browser.

export { Jar };
export type { ErrorBody };

const HOUR = 60 * 60 * 1000;
export const NOW = Date.now();

let counter = 0;
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function listingId(): string {
  counter += 1;
  let n = counter;
  let id = "";
  for (let i = 0; i < 7; i += 1) {
    id = `${ID_ALPHABET[n % ID_ALPHABET.length]}${id}`;
    n = Math.floor(n / ID_ALPHABET.length);
  }
  return `t${id}`;
}

export interface DocInput extends Partial<SearchDocument> {
  title: string;
  subcategoryId: string;
  categoryId: string;
  citySlug: string;
}

/** A search document as the indexer would write it (text fields kept short and explicit). */
export function doc(input: DocInput): SearchDocument {
  const city = cityBySlug(input.citySlug);
  if (!city) throw new Error(`unknown city ${input.citySlug}`);
  const id = input.id ?? listingId();
  return {
    id,
    slugId: `${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${id}`,
    description: "",
    categoryText: "",
    placeText: `${city.nameFr} ${city.nameAr}`,
    attrsText: "",
    regionCode: city.regionCode,
    sellerType: "individual",
    sellerPublicId: "abcdefghjk",
    priceNegotiable: false,
    isDonation: false,
    hasPhoto: false,
    photoCount: 0,
    sortAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    sitemapShard: sitemapShardOf(id),
    isBumped: false,
    _geo: { lat: city.lat, lng: city.lng },
    version: 1,
    ...input,
  };
}

/** Fresh memory engine holding `documents`, installed as the search engine. */
export async function serve(documents: SearchDocument[]): Promise<MemoryEngine> {
  const engine = new MemoryEngine();
  await engine.upsert(documents);
  setSearchEngineForTests(engine);
  return engine;
}

export interface SearchCall<T> {
  status: number;
  body: T;
  header(name: string): string | null;
  cookies: string[];
}

export interface SearchOptions {
  jar?: Jar;
  headers?: Record<string, string>;
}

/** GET /api/search?`query` as a browser would (jar cookies in, Set-Cookie absorbed). */
export async function search<T>(query: string, options: SearchOptions = {}): Promise<SearchCall<T>> {
  const jar = options.jar ?? new Jar();
  const headers = new Headers({ host: "localhost:3000", "x-forwarded-for": jar.ip, "user-agent": "vitest" });
  const cookie = jar.header();
  if (cookie) headers.set("cookie", cookie);
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  const path = query ? `/api/search?${query}` : "/api/search";
  const response = await GET(new NextRequest(`${ORIGIN}${path}`, { headers }), { params: Promise.resolve({}) });
  jar.absorb(response);
  return { status: response.status, body: (await response.json()) as T, header: (name) => response.headers.get(name), cookies: response.headers.getSetCookie() };
}
