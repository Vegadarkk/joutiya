import { z } from "@/lib/zod";
import { CONDITIONS, criteriaSchema, subcategoryById, type Criterion, type Subcategory } from "@/config/categories";
import { cityBySlug } from "@/config/regions";
import {
  DESCRIPTION_MAX,
  DESCRIPTION_MIN,
  DISTRICT_MAX,
  PRICE_MAX,
  TITLE_MAX,
  TITLE_MIN,
  WIZARD_STEPS,
  descriptionSchema,
  listingContactInputSchema,
  listingLocationInputSchema,
  priceSchema,
  titleSchema,
  type FieldIssue,
  type OwnerListing,
  type WizardStep,
} from "@/lib/contracts/listings";
import { MAX_PHOTOS_PRO } from "@/lib/contracts/media";

// Per-step readiness of the posting wizard (design D3), derived from the shared contracts so the
// browser and the API agree. Pure and client-safe: used by the step forms (zod resolver), the
// progress indicator, the review step and the mapping of the server's 422 blockers to steps.

/** The part of the listing the steps validate. */
export type DraftLike = Pick<
  OwnerListing,
  "categoryId" | "subcategoryId" | "title" | "description" | "attributes" | "condition" | "price" | "priceNegotiable" | "isDonation" | "location" | "photos" | "contact"
>;

export { TITLE_MIN, TITLE_MAX, DESCRIPTION_MIN, DESCRIPTION_MAX, PRICE_MAX, DISTRICT_MAX };

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step);
}

export function isWizardStep(value: string | undefined): value is WizardStep {
  return value !== undefined && (WIZARD_STEPS as readonly string[]).includes(value);
}

export function nextStep(step: WizardStep): WizardStep | null {
  return WIZARD_STEPS[stepIndex(step) + 1] ?? null;
}

export function previousStep(step: WizardStep): WizardStep | null {
  const index = stepIndex(step);
  return index > 0 ? (WIZARD_STEPS[index - 1] ?? null) : null;
}

/** The step a listing field belongs to (FieldIssue.path -> step), for the blocker jump links. */
export function stepOfPath(path: string): WizardStep {
  const head = path.split(".")[0] ?? "";
  switch (head) {
    case "categoryId":
    case "subcategoryId":
      return "categorie";
    case "attributes":
    case "condition":
      return "criteres";
    case "title":
      return "titre";
    case "description":
      return "description";
    case "photos":
      return "photos";
    case "price":
    case "priceNegotiable":
    case "isDonation":
      return "prix";
    case "location":
      return "lieu";
    case "contact":
    case "sensitiveDeclaration":
      return "contact";
    default:
      return "apercu";
  }
}

// --- Step schemas (react-hook-form resolvers) -------------------------------------------------

const treeId = z.string().min(1);

export const categoryStepSchema = z
  .object({ categoryId: treeId, subcategoryId: treeId })
  .superRefine((data, ctx) => {
    const subcategory = subcategoryById(data.subcategoryId);
    if (!subcategory || subcategory.categoryId !== data.categoryId) {
      ctx.addIssue({ code: "custom", path: ["subcategoryId"], message: "subcategory_required" });
    }
  });

/** `condition` is a core field (not an attribute): required, optional or absent per subcategory. */
function conditionSchema(subcategory: Subcategory | undefined) {
  const condition = z.enum(CONDITIONS);
  if (!subcategory?.condition) return z.null().optional();
  return subcategory.condition === "required" ? condition : condition.nullable().optional();
}

/** `{ attributes, condition }` of a subcategory; an unknown subcategory accepts nothing. */
export function criteriaStepSchema(subcategoryId: string | null) {
  const subcategory = subcategoryId ? subcategoryById(subcategoryId) : undefined;
  const attributes = subcategory ? criteriaSchema(subcategory.id) : z.object({}).strict();
  return z.object({ attributes, condition: conditionSchema(subcategory) });
}

export const titleStepSchema = z.object({ title: titleSchema });
export const descriptionStepSchema = z.object({ description: descriptionSchema });

export function photosStepSchema(maxPhotos: number = MAX_PHOTOS_PRO) {
  return z.object({ photos: z.array(z.string()).max(maxPhotos) });
}

/** Price rules (D4): null only as a donation or when the subcategory allows "à discuter". */
export function priceStepSchema(subcategoryId: string | null) {
  const priceOptional = Boolean(subcategoryId && subcategoryById(subcategoryId)?.priceOptional);
  return z
    .object({ price: priceSchema.nullable(), priceNegotiable: z.boolean(), isDonation: z.boolean() })
    .superRefine((data, ctx) => {
      if (data.price === null && !data.isDonation && !priceOptional) {
        ctx.addIssue({ code: "custom", path: ["price"], message: "price_required" });
      }
    });
}

export const locationStepSchema = z.object({
  location: listingLocationInputSchema.superRefine((location, ctx) => {
    const city = cityBySlug(location.citySlug);
    if (!city || city.regionCode !== location.regionCode) {
      ctx.addIssue({ code: "custom", path: ["citySlug"], message: "city_required" });
    }
  }),
});

export const contactStepSchema = z.object({ contact: listingContactInputSchema });

// --- Readiness --------------------------------------------------------------------------------

type ZodIssueLike = { code: string; path: PropertyKey[]; message: string; origin?: string };

function valueAt(values: unknown, path: PropertyKey[]): unknown {
  let current: unknown = values;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

function issueCode(path: string, issue: ZodIssueLike, value: unknown): string {
  // Custom refinements carry the stable code in their message.
  if (issue.code === "custom") return issue.message;
  const head = path.split(".")[0];
  const missing = value === undefined || value === null || value === "";
  if (head === "attributes") {
    if (missing) return "criterion_required";
    if (issue.code === "too_small") return issue.origin === "string" ? "criterion_required" : "criterion_min";
    if (issue.code === "too_big") return issue.origin === "string" ? "criterion_text_max" : "criterion_max";
    if (issue.code === "not_multiple_of") return "criterion_integer";
    return "criterion_invalid";
  }
  switch (head) {
    case "categoryId":
      return "category_required";
    case "subcategoryId":
      return "subcategory_required";
    case "condition":
      return "condition_required";
    case "title":
      return issue.code === "too_big" ? "title_max" : "title_min";
    case "description":
      return issue.code === "too_big" ? "description_max" : "description_min";
    case "price":
      return issue.code === "too_big" ? "price_max" : "price_invalid";
    case "location":
      return path.endsWith("district") ? "district_max" : "city_required";
    case "photos":
      return issue.code === "too_big" ? "photos_max" : "photos_required";
    default:
      return "unknown";
  }
}

function toIssues(result: z.ZodSafeParseResult<unknown>, values: unknown): FieldIssue[] {
  if (result.success) return [];
  const seen = new Set<string>();
  const issues: FieldIssue[] = [];
  for (const issue of result.error.issues as ZodIssueLike[]) {
    const path = issue.path.map(String).join(".");
    if (seen.has(path)) continue;
    seen.add(path);
    issues.push({ path, code: issueCode(path, issue, valueAt(values, issue.path)) });
  }
  return issues;
}

/** Form values of a step, as the step component edits them. */
export function stepValues(step: WizardStep, draft: DraftLike): Record<string, unknown> {
  switch (step) {
    case "categorie":
      return { categoryId: draft.categoryId ?? "", subcategoryId: draft.subcategoryId ?? "" };
    case "criteres":
      return { attributes: draft.attributes, condition: draft.condition };
    case "titre":
      return { title: draft.title };
    case "description":
      return { description: draft.description };
    case "photos":
      return { photos: draft.photos.filter((photo) => photo.status === "ready").map((photo) => photo.id) };
    case "prix":
      return { price: draft.price, priceNegotiable: draft.priceNegotiable, isDonation: draft.isDonation };
    case "lieu":
      return { location: draft.location ?? { regionCode: "", citySlug: "" } };
    case "contact":
      return { contact: draft.contact };
    case "apercu":
      return {};
  }
}

/** The blocking issues of one step (empty = the step is complete). The review step has none of its own. */
export function stepIssues(step: WizardStep, draft: DraftLike, options: { maxPhotos?: number } = {}): FieldIssue[] {
  const values = stepValues(step, draft);
  switch (step) {
    case "categorie":
      return toIssues(categoryStepSchema.safeParse(values), values);
    case "criteres":
      return draft.subcategoryId ? toIssues(criteriaStepSchema(draft.subcategoryId).safeParse(values), values) : [{ path: "subcategoryId", code: "subcategory_required" }];
    case "titre":
      return toIssues(titleStepSchema.safeParse(values), values);
    case "description":
      return toIssues(descriptionStepSchema.safeParse(values), values);
    case "photos":
      return toIssues(photosStepSchema(options.maxPhotos).safeParse(values), values);
    case "prix":
      return toIssues(priceStepSchema(draft.subcategoryId).safeParse(values), values);
    case "lieu":
      return dedupeLocationIssues(toIssues(locationStepSchema.safeParse(values), values));
    case "contact":
      return toIssues(contactStepSchema.safeParse(values), values);
    case "apercu":
      return [];
  }
}

/** The city field carries region and slug together: one blocker for both, under the slug path. */
function dedupeLocationIssues(issues: FieldIssue[]): FieldIssue[] {
  const out: FieldIssue[] = [];
  let cityIssue = false;
  for (const issue of issues) {
    if (issue.code === "city_required") {
      if (cityIssue) continue;
      cityIssue = true;
      out.push({ ...issue, path: "location.citySlug" });
    } else {
      out.push(issue);
    }
  }
  return out;
}

export type StepState = "complete" | "incomplete" | "empty";

/** A step with no issue is complete; without any value entered yet it is "empty" (shown as to do, not as an error). */
export function stepState(step: WizardStep, draft: DraftLike, options: { maxPhotos?: number } = {}): StepState {
  if (step === "apercu") return "incomplete";
  if (stepIssues(step, draft, options).length === 0) return "complete";
  return isStepTouched(step, draft) ? "incomplete" : "empty";
}

function isStepTouched(step: WizardStep, draft: DraftLike): boolean {
  switch (step) {
    case "categorie":
      return Boolean(draft.categoryId);
    case "criteres":
      return Object.keys(draft.attributes).length > 0 || draft.condition !== null;
    case "titre":
      return draft.title.length > 0;
    case "description":
      return draft.description.length > 0;
    case "photos":
      return draft.photos.length > 0;
    case "prix":
      return draft.price !== null || draft.isDonation;
    case "lieu":
      return draft.location !== null;
    case "contact":
    case "apercu":
      return true;
  }
}

/** Every issue of the listing with the step it belongs to (the review step's checklist). */
export function allIssues(draft: DraftLike, options: { maxPhotos?: number } = {}): (FieldIssue & { step: WizardStep })[] {
  return WIZARD_STEPS.flatMap((step) => stepIssues(step, draft, options).map((issue) => ({ ...issue, step })));
}

/** Where to resume: the first step with an issue, else the review step. */
export function firstIncompleteStep(draft: DraftLike, options: { maxPhotos?: number } = {}): WizardStep {
  for (const step of WIZARD_STEPS) {
    if (step === "apercu") break;
    if (stepIssues(step, draft, options).length > 0) return step;
  }
  return "apercu";
}

/** Numeric bounds of a criterion, for the validation messages. */
export function criterionBounds(criterion: Criterion): { min?: number; max?: number } {
  return { ...(criterion.min !== undefined ? { min: criterion.min } : {}), ...(criterion.max !== undefined ? { max: criterion.max } : {}) };
}
