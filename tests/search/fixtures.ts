import { cityBySlug, regionByCode } from "@/config/regions";
import { attributeField, sitemapShardOf, type SearchDocument } from "@/lib/search/types";

// Listings of the engine contract suite (tests/search/contract.ts): same documents for the memory
// engine and Meilisearch. Texts follow what the indexer writes (names in French and Arabic).

export const NOW = Date.UTC(2026, 9, 16, 12);
const DAY = 86_400_000;

interface DocInput {
  id: string;
  title: string;
  description?: string;
  categoryId: string;
  subcategoryId: string;
  categoryText: string;
  citySlug: string;
  district?: string;
  price?: number;
  isDonation?: boolean;
  sellerType?: "individual" | "pro";
  condition?: SearchDocument["condition"];
  hasPhoto?: boolean;
  daysAgo: number;
  attributes?: Record<string, string | string[] | number | boolean>;
  attrsText?: string;
  featuredUntil?: number;
  isBumped?: boolean;
}

export function searchDoc(input: DocInput): SearchDocument {
  const city = cityBySlug(input.citySlug);
  const region = city ? regionByCode(city.regionCode) : undefined;
  if (!city || !region) throw new Error(`unknown city ${input.citySlug}`);
  const doc: SearchDocument = {
    id: input.id,
    slugId: `${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "annonce"}-${input.id}`,
    title: input.title,
    description: input.description ?? "",
    categoryText: input.categoryText,
    placeText: [city.nameFr, city.nameAr, region.nameFr, region.nameAr, input.district ?? ""].join(" ").trim(),
    attrsText: input.attrsText ?? "",
    categoryId: input.categoryId,
    subcategoryId: input.subcategoryId,
    regionCode: city.regionCode,
    citySlug: city.slug,
    sellerType: input.sellerType ?? "individual",
    sellerPublicId: "abcdefghjk",
    priceNegotiable: false,
    isDonation: input.isDonation ?? false,
    hasPhoto: input.hasPhoto ?? true,
    photoCount: input.hasPhoto === false ? 0 : 1,
    sortAt: NOW - input.daysAgo * DAY,
    updatedAt: NOW - input.daysAgo * DAY,
    sitemapShard: sitemapShardOf(input.id),
    isBumped: input.isBumped ?? false,
    _geo: { lat: city.lat, lng: city.lng },
    version: 1,
  };
  if (input.district) doc.district = input.district;
  if (input.price !== undefined) doc.price = input.price;
  if (input.condition) doc.condition = input.condition;
  if (input.featuredUntil !== undefined) doc.featuredUntil = input.featuredUntil;
  if (doc.hasPhoto) doc.photo = { id: "p1", w: 800, h: 600, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" };
  for (const [criterion, value] of Object.entries(input.attributes ?? {})) doc[attributeField(criterion)] = value;
  return doc;
}

const CARS = "Véhicules مركبات Voitures سيارات";
const SALE = "Immobilier عقارات Vente بيع";
const RENT = "Immobilier عقارات Location كراء";
const PHONES = "Électronique إلكترونيات Téléphones هواتف";
const FURNITURE = "Maison et jardin المنزل والحديقة Ameublement أثاث";

export const DOCS: SearchDocument[] = [
  searchDoc({ id: "v1", title: "Dacia Logan diesel 2016 très propre", categoryId: "vehicules", subcategoryId: "voitures", categoryText: CARS, citySlug: "casablanca", district: "maarif", price: 75_000, daysAgo: 1, attributes: { "car-brand": "dacia", year: 2016, fuel: "diesel", mileage: 120_000 }, attrsText: "Dacia Diesel Manuelle" }),
  searchDoc({ id: "v2", title: "Volkswagen Golf 7 GTD", categoryId: "vehicules", subcategoryId: "voitures", categoryText: CARS, citySlug: "rabat", price: 180_000, sellerType: "pro", daysAgo: 3, attributes: { "car-brand": "volkswagen", year: 2017, fuel: "diesel" }, attrsText: "Volkswagen Diesel Automatique", featuredUntil: NOW + 2 * DAY }),
  searchDoc({ id: "v3", title: "Peugeot 206 2007", categoryId: "vehicules", subcategoryId: "voitures", categoryText: CARS, citySlug: "marrakech", price: 32_000, daysAgo: 10, attributes: { "car-brand": "peugeot", year: 2007, fuel: "essence" }, attrsText: "Peugeot Essence", isBumped: true, featuredUntil: NOW - DAY }),
  searchDoc({ id: "i1", title: "Appartement 3 chambres Maarif", description: "Bel appartement lumineux, cuisine équipée.", categoryId: "immobilier", subcategoryId: "vente", categoryText: SALE, citySlug: "casablanca", district: "maarif", price: 1_450_000, daysAgo: 2, attributes: { "property-type": "appartement", surface: 95, amenities: ["parking", "ascenseur"], furnished: false }, attrsText: "Appartement Parking Ascenseur" }),
  searchDoc({ id: "i2", title: "شقة للكراء قرب البحر", categoryId: "immobilier", subcategoryId: "location", categoryText: RENT, citySlug: "mohammedia", price: 4_500, daysAgo: 5, attributes: { "property-type": "appartement", amenities: ["climatisation"], furnished: true }, attrsText: "Appartement Climatisation" }),
  searchDoc({ id: "i3", title: "Villa avec piscine", categoryId: "immobilier", subcategoryId: "vente", categoryText: SALE, citySlug: "el-jadida", price: 3_200_000, daysAgo: 20, attributes: { "property-type": "villa-riad" }, attrsText: "Villa riad" }),
  searchDoc({ id: "e1", title: "iPhone 13 Pro 256 Go", categoryId: "electronique", subcategoryId: "telephones-objets-connectes", categoryText: PHONES, citySlug: "tanger", price: 7_500, condition: "like_new", daysAgo: 4, attributes: { "phone-brand": "apple", storage: "256-go" }, attrsText: "Apple" }),
  searchDoc({ id: "e2", title: "iPhone 11 128 Go", categoryId: "electronique", subcategoryId: "telephones-objets-connectes", categoryText: PHONES, citySlug: "casablanca", district: "ain diab", price: 3_500, condition: "good", daysAgo: 6, attributes: { "phone-brand": "apple", storage: "128-go" }, attrsText: "Apple" }),
  searchDoc({ id: "m1", title: "Canapé salon marocain", categoryId: "maison-jardin", subcategoryId: "ameublement", categoryText: FURNITURE, citySlug: "rabat", hasPhoto: false, daysAgo: 7 }),
  searchDoc({ id: "m2", title: "Table en bois massif", categoryId: "maison-jardin", subcategoryId: "ameublement", categoryText: FURNITURE, citySlug: "casablanca", isDonation: true, daysAgo: 8, attributes: { material: "bois" } }),
  searchDoc({ id: "a1", title: "Mouton sardi pour l'Aïd", categoryId: "animaux", subcategoryId: "betail-moutons", categoryText: "Animaux حيوانات Bétail ماشية", citySlug: "el-jadida", price: 4_000, daysAgo: 9, attributes: { "livestock-type": "mouton", "head-count": 1 } }),
  searchDoc({ id: "s1", title: "Cours de soutien en mathématiques", categoryId: "services", subcategoryId: "cours", categoryText: "Services خدمات Cours دروس", citySlug: "marrakech", price: 150, sellerType: "pro", daysAgo: 11, attributes: { "course-subject": "soutien-scolaire" } }),
];

/** Ids by sortAt desc (newest first). */
export const NEWEST_FIRST = [...DOCS].sort((a, b) => b.sortAt - a.sortAt).map((doc) => doc.id);
