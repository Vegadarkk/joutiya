// Plausible price envelopes per subcategory, integer MAD (architecture §7 step 4 "prix anormal
// pour la catégorie"; design D8). A price is a `price_outlier` when it leaves the envelope by
// PRICE_OUTLIER_FACTOR: price * factor < min, or price > max * factor. Static first cut, to be
// replaced by observed quantiles once there is data (phase 4+). Rental prices are per the
// subcategory `priceUnit` (day / month / night). `divers/autres` has no envelope on purpose.
// Client-safe (no dependency).

export interface PriceRange {
  min: number;
  max: number;
}

export const PRICE_OUTLIER_FACTOR = 3;

export const PRICE_RANGES: Readonly<Record<string, PriceRange>> = {
  // vehicules
  voitures: { min: 15_000, max: 2_000_000 },
  "location-voitures": { min: 150, max: 5_000 },
  "motos-scooters": { min: 2_000, max: 300_000 },
  velos: { min: 300, max: 60_000 },
  "utilitaires-camions": { min: 20_000, max: 3_000_000 },
  bateaux: { min: 5_000, max: 5_000_000 },
  "pieces-accessoires": { min: 20, max: 100_000 },
  // immobilier
  vente: { min: 150_000, max: 30_000_000 },
  location: { min: 800, max: 60_000 },
  colocation: { min: 500, max: 8_000 },
  "location-vacances": { min: 150, max: 15_000 },
  // electronique
  "telephones-objets-connectes": { min: 100, max: 40_000 },
  ordinateurs: { min: 500, max: 80_000 },
  tablettes: { min: 200, max: 30_000 },
  "accessoires-electronique": { min: 10, max: 10_000 },
  "tv-photo-audio": { min: 100, max: 100_000 },
  "consoles-jeux-video": { min: 50, max: 15_000 },
  // maison-jardin
  ameublement: { min: 50, max: 100_000 },
  electromenager: { min: 50, max: 60_000 },
  "decoration-artisanat": { min: 20, max: 100_000 },
  "koumiyas-decoratives": { min: 50, max: 200_000 },
  linge: { min: 20, max: 10_000 },
  "arts-de-la-table": { min: 20, max: 50_000 },
  bricolage: { min: 20, max: 50_000 },
  jardin: { min: 20, max: 50_000 },
  // mode
  vetements: { min: 20, max: 20_000 },
  "tenues-traditionnelles": { min: 100, max: 50_000 },
  chaussures: { min: 30, max: 15_000 },
  "sacs-accessoires": { min: 20, max: 50_000 },
  "montres-bijoux": { min: 50, max: 500_000 },
  "beaute-soins": { min: 10, max: 10_000 },
  // terroir (retail jar to a producer's bulk lot)
  "huile-olive": { min: 30, max: 100_000 },
  "huile-argan-alimentaire": { min: 50, max: 100_000 },
  miel: { min: 30, max: 100_000 },
  "amlou-pates-a-tartiner": { min: 20, max: 30_000 },
  "dattes-fruits-secs": { min: 20, max: 100_000 },
  "epices-herbes": { min: 10, max: 50_000 },
  "autres-produits-terroir": { min: 10, max: 50_000 },
  // famille
  "equipement-bebe": { min: 20, max: 15_000 },
  "vetements-enfant": { min: 10, max: 3_000 },
  "mobilier-enfant": { min: 50, max: 15_000 },
  // loisirs
  "sport-plein-air": { min: 20, max: 50_000 },
  instruments: { min: 100, max: 100_000 },
  livres: { min: 5, max: 5_000 },
  "jeux-jouets": { min: 10, max: 10_000 },
  "collection-antiquites": { min: 20, max: 1_000_000 },
  // animaux
  "accessoires-animaux": { min: 10, max: 10_000 },
  "animaux-compagnie": { min: 100, max: 50_000 },
  "betail-moutons": { min: 500, max: 100_000 },
  // materiel-pro
  "agricole-tracteurs": { min: 1_000, max: 2_000_000 },
  btp: { min: 500, max: 5_000_000 },
  chr: { min: 200, max: 1_000_000 },
  "commerce-bureau": { min: 50, max: 500_000 },
  medical: { min: 100, max: 2_000_000 },
  "stocks-gros": { min: 500, max: 5_000_000 },
  // services
  cours: { min: 50, max: 5_000 },
  "demenagement-transport": { min: 100, max: 50_000 },
  "travaux-reparations": { min: 50, max: 500_000 },
  menage: { min: 50, max: 10_000 },
  evenements: { min: 200, max: 500_000 },
  beaute: { min: 30, max: 10_000 },
};

export function priceRange(subcategoryId: string): PriceRange | undefined {
  return PRICE_RANGES[subcategoryId];
}

/**
 * True when `price` is implausible for the subcategory: outside the envelope by the factor, or a
 * symbolic 0 where the envelope starts above 0 (free goods go through `isDonation`). Unknown
 * subcategory or no envelope: never an outlier.
 */
export function isPriceOutlier(price: number, subcategoryId: string, factor = PRICE_OUTLIER_FACTOR): boolean {
  const range = priceRange(subcategoryId);
  if (!range || !Number.isFinite(price)) return false;
  if (price <= 0) return range.min > 0;
  return price * factor < range.min || price > range.max * factor;
}
