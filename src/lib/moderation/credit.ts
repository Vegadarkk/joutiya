// Credit advertising without its mandatory mentions (loi 31-08 art. 76, Concession pack design §7):
// a listing that quotes an instalment ("2 500 DH par mois", "mensualités de 1 900 DH", "بالتقسيط
// 3000 درهم شهريا") must also give the lender, the duration, the total cost and the annual
// percentage rate (TEG). The screen only spots an instalment figure without "TEG" and sends the
// listing to a moderator (`credit_ad`, always reviewed): the moderator judges the mentions. Rent is
// not credit: subcategories priced per month or night (rentals) are skipped by the caller.

/** Credit words, French, darija in Latin script and Arabic. */
const CREDIT_WORDS = /mensualit[eé]s?|cr[eé]dit|financement|leasing|\bloa\b|\blld\b|apport|taqsit|ta9sit|تقسيط|بالتقسيط|قرض|أقساط|اقساط|قسط/iu;

/** A figure tied to a month: "2500 dh/mois", "1 900 DH par mois", "3000 درهم شهريا", "mensualité de 1 900". */
const MONTHLY_FIGURE =
  /\d[\d\s.,]*\s*(?:dh|dhs|mad|درهم)?\s*(?:\/\s*mois|par\s+mois|mensuel(?:le)?s?|chaque\s+mois|f\s*chhar|fi\s*chhar|kol\s*chhar|شهريا|شهريًا|في\s*الشهر|كل\s*شهر|\/\s*شهر)|mensualit[eé]s?\s+(?:de|à|a)\s+\d|أقساط\s*(?:ب|من)?\s*\d|قسط\s*(?:شهري)?\s*\d/iu;

/** The annual percentage rate named: "TEG", "taux effectif global", "السعر الفعلي الإجمالي". */
const APR_MENTION = /\bteg\b|taux\s+effectif\s+global|السعر\s+الفعلي\s+الإجمالي/iu;

/** True when `text` quotes an instalment figure for a credit without naming the TEG. */
export function quotesCreditWithoutApr(text: string): boolean {
  const flat = text.normalize("NFKC");
  return CREDIT_WORDS.test(flat) && MONTHLY_FIGURE.test(flat) && !APR_MENTION.test(flat);
}
