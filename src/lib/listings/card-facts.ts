import { categoryById, criterionById, subcategoryById } from "@/config/categories";

// Key facts of a result card (Agence pack design §2): the category's `cardFacts` (number criteria
// such as the surface and the rooms) and the exclusive mandate of a real-estate agency. Built from
// a listing's attributes (Firestore cards) or from the index's `a_*` fields (search cards), so
// both card sources show the same line. A zero (a studio's bedrooms) says nothing on a card. Client-safe.

export interface CardFact {
  id: string;
  value: number;
}

export interface CardFacts {
  facts: CardFact[];
  /** Exclusive mandate (`mandate = exclusif`): "Exclusivité" on the card. */
  exclusive: boolean;
}

export const NO_CARD_FACTS: CardFacts = { facts: [], exclusive: false };

/** `read(criterionId)` returns the listing's value for that criterion, whatever its source. */
export function cardFactsOf(subcategoryId: string | null | undefined, read: (criterionId: string) => unknown): CardFacts {
  const subcategory = subcategoryId ? subcategoryById(subcategoryId) : undefined;
  if (!subcategory) return NO_CARD_FACTS;
  const declared = new Set(subcategory.criteria.map((criterion) => criterion.id));
  const facts: CardFact[] = [];
  for (const id of categoryById(subcategory.categoryId)?.cardFacts ?? []) {
    const value = read(id);
    if (declared.has(id) && criterionById(id)?.type === "number" && typeof value === "number" && Number.isFinite(value) && value > 0) facts.push({ id, value });
  }
  return { facts, exclusive: declared.has("mandate") && read("mandate") === "exclusif" };
}

/** `{ facts }` to spread into a card, or nothing when there is none to show. */
export function cardFactsField(facts: CardFacts): { facts?: CardFacts } {
  return facts.facts.length > 0 || facts.exclusive ? { facts } : {};
}
