import { RENTAL_SUBCATEGORY } from "@/config/categories";

// Car rental listings a moderator reads before they go public (rental pack, design §2 and §7):
// a rental "with driver" (tourist transport, another licence), a passport or ID card kept as a
// guarantee or a blank cheque (contested practices, no text found: reviewed, not refused), and a
// vehicle past the fleet age limits reported for the 2024 specifications (5 years, 7 for an
// electric car). Flag `rental_review`, always reviewed.

/** "avec chauffeur", "chauffeur inclus", "مع السائق", "b chifour". */
const WITH_DRIVER = /avec\s+(?:son\s+|un\s+|le\s+)?chauffeur|chauffeur\s+(?:inclus|compris|fourni)|مع\s*(?:ال)?سائق|b\s*chif+[eo]u?r|m3a\s*chif+[eo]u?r/iu;

/** Identity paper or blank cheque kept as a guarantee. */
const GUARANTEE = /(?:passeport|passport|cin|carte\s+d['’]?identit[eé]|جواز\s*(?:ال)?سفر|البطاقة\s*الوطنية|بطاقة\s*التعريف)[^.\n]{0,40}(?:en\s+)?(?:garantie|caution|d[eé]p[oô]t|ضمان|رهن)|(?:garantie|caution|ضمان)[^.\n]{0,40}(?:passeport|passport|\bcin\b|carte\s+d['’]?identit[eé]|جواز|البطاقة\s*الوطنية)|ch[eè]que\s+(?:de\s+garantie\s+)?(?:en\s+)?blanc|شيك\s*(?:على\s*)?بياض/iu;

/** Reported fleet age limits, years since the model year (combustion and hybrid at 5, a lenient bound). */
export const RENTAL_AGE_MAX_YEARS = 5;
export const RENTAL_AGE_MAX_YEARS_ELECTRIC = 7;

/** Reasons a rental listing goes to a moderator; empty for any other subcategory. */
export function rentalReviewReasons(input: { subcategoryId?: string; title?: string; description?: string; attributes?: Readonly<Record<string, unknown>> }, now: Date): string[] {
  if (input.subcategoryId !== RENTAL_SUBCATEGORY) return [];
  const reasons: string[] = [];
  const text = `${input.title ?? ""}\n${input.description ?? ""}`.normalize("NFKC");
  if (WITH_DRIVER.test(text)) reasons.push("rental with driver");
  if (GUARANTEE.test(text)) reasons.push("identity paper or blank cheque as a guarantee");
  const year = input.attributes?.["year"];
  if (typeof year === "number") {
    const max = input.attributes?.["fuel"] === "electrique" ? RENTAL_AGE_MAX_YEARS_ELECTRIC : RENTAL_AGE_MAX_YEARS;
    if (now.getUTCFullYear() - year > max) reasons.push(`vehicle from ${year}, past the ${max}-year fleet limit`);
  }
  return reasons;
}
