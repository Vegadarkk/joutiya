import type { GuideProcedureId, GuideRubric } from "@/content/guide/catalog";
import { GUIDE_PROCEDURES } from "@/content/guide/catalog";
import type { ProSector } from "./profile-schema";

// Legal commitments shown wherever a shop or an agency is created (owner ask 2026-10-29): the Pro
// application, a sector change to an agency, and the Pass Boutique. Each scope lists what the owner
// commits to (texts in Pro.commitments.items.* of messages/*.json) and the procedures of the admin
// guide (/demarches) that explain the registrations behind them. The owner ticks one explicit
// acknowledgment; the server refuses the action without it and records `COMMITMENTS_VERSION`.
// Client-safe.

/** Version of the commitments text (Pro.commitments in messages/*.json), recorded with each acknowledgment. */
export const COMMITMENTS_VERSION = "2026-10-29";

export const COMMITMENT_SCOPES = ["shop", "pass", "real_estate", "car_rental", "holiday_rental"] as const;
export type CommitmentScope = (typeof COMMITMENT_SCOPES)[number];

/** Commitment keys every shop takes, then the ones of an agency's trade. */
const SHOP_ITEMS = ["identity", "registered", "lawful", "responsible"] as const;
export const COMMITMENT_ITEMS = {
  shop: SHOP_ITEMS,
  pass: [...SHOP_ITEMS, "temporary"],
  real_estate: ["mandate", "property", "tourism", "responsible"],
  car_rental: ["agrement", "fleet", "contract", "responsible"],
  holiday_rental: ["authorisation", "guests", "touristTax", "owners", "responsible"],
} as const satisfies Record<CommitmentScope, readonly string[]>;
export type CommitmentItem = (typeof COMMITMENT_ITEMS)[CommitmentScope][number];

export interface CommitmentGuideLink {
  rubric: GuideRubric;
  procedure: GuideProcedureId;
}

const link = <P extends GuideProcedureId>(procedure: P) => ({ rubric: GUIDE_PROCEDURES[procedure].rubric as GuideRubric, procedure });

/**
 * Guide procedures per scope. Only procedures whose official links are confirmed (a procedure whose
 * links are all hidden is not on its rubric page; tests/unit/pro-commitments.test.ts checks it).
 */
export const COMMITMENT_GUIDE = {
  shop: [link("pro-societe"), link("pro-ice"), link("pro-obligations"), link("ae-impots")],
  pass: [link("pro-ice"), link("pro-obligations"), link("ae-impots")],
  real_estate: [link("immo-verifier"), link("immo-location"), link("pro-obligations")],
  car_rental: [link("vehicule-mutation"), link("pro-societe"), link("pro-obligations")],
  holiday_rental: [link("immo-location-touristique"), link("immo-taxes-locales"), link("pro-obligations")],
} as const satisfies Readonly<Record<CommitmentScope, readonly CommitmentGuideLink[]>>;

/** The commitments a sector adds to the shop's own, or null for a general shop. */
export function sectorCommitmentScope(sector: ProSector): CommitmentScope | null {
  return sector === "general" ? null : sector;
}

/** Deep link to a procedure of the guide (its heading id on the rubric page). */
export const guideProcedureHref = ({ rubric, procedure }: CommitmentGuideLink) => `/demarches/${rubric}#procedure-${procedure}` as const;
