import { z } from "@/lib/zod";
import type { ModerationFlag } from "@/lib/contracts/listings";

// Human decisions of the minimal moderation queue (design D9, architecture §7 step 8): the reject
// reason templates (staff label in French, statement facts in French and Arabic, ground) and the
// decision request of POST /api/admin/moderation/{id}. Client-safe: the back-office form imports
// it; the writes live in src/lib/listings/moderation-actions.ts.

export const REJECT_REASON_CODES = [
  "prohibited",
  "counterfeit",
  "third_party_data",
  "sensitive_data",
  "misleading",
  "photos",
  "category",
  "scam",
  "pro_as_individual",
  "spam",
  "other",
] as const;
export type RejectReasonCode = (typeof REJECT_REASON_CODES)[number];

export interface RejectReason {
  /** Short label of the back-office form. */
  label: string;
  /** The fact as told to the seller (statement of reasons), per mail language. */
  facts: { fr: string; ar: string };
  /** moderationDecisions.ground (ref <= 64 characters). */
  ground: { type: "illegal" | "terms"; ref: string };
  /** The moderator must explain in their own words. */
  detailsRequired?: boolean;
}

const LISTING_RULES = "CGU « Publication des annonces »";

export const REJECT_REASONS: Record<RejectReasonCode, RejectReason> = {
  prohibited: {
    label: "Objet ou service interdit",
    facts: {
      fr: "l'annonce propose un objet ou un service interdit sur Joutiya (voir la page « Objets interdits »)",
      ar: "يعرض الإعلان غرضًا أو خدمة ممنوعة على Joutiya (انظر صفحة «الأغراض الممنوعة»)",
    },
    ground: { type: "terms", ref: `${LISTING_RULES}, objets interdits` },
  },
  counterfeit: {
    label: "Contrefaçon",
    facts: { fr: "l'annonce semble proposer une contrefaçon ou une copie d'une marque", ar: "يبدو أن الإعلان يعرض منتجًا مقلّدًا أو نسخة من علامة تجارية" },
    ground: { type: "terms", ref: `${LISTING_RULES}, objets interdits` },
  },
  third_party_data: {
    label: "Données d'un tiers",
    facts: {
      fr: "l'annonce contient des données personnelles d'un tiers (photo reconnaissable, nom ou numéro) sans son accord",
      ar: "يحتوي الإعلان على بيانات شخصية لشخص آخر (صورة يمكن التعرف عليه فيها أو اسم أو رقم) دون موافقته",
    },
    ground: { type: "terms", ref: `${LISTING_RULES}, données d'un tiers` },
  },
  sensitive_data: {
    label: "Données sensibles",
    facts: {
      fr: "l'annonce contient une donnée sensible (santé, opinions politiques ou religieuses, orientation sexuelle, origine)",
      ar: "يحتوي الإعلان على بيانات حساسة (الصحة، الآراء السياسية أو الدينية، التوجه الجنسي، الأصل)",
    },
    ground: { type: "terms", ref: `${LISTING_RULES}, données sensibles` },
  },
  misleading: {
    label: "Annonce trompeuse",
    facts: { fr: "la description, le prix ou les photos ne correspondent pas au bien proposé", ar: "الوصف أو السعر أو الصور لا تطابق المنتج المعروض" },
    ground: { type: "terms", ref: `${LISTING_RULES}, exactitude` },
  },
  photos: {
    label: "Photos non conformes",
    facts: {
      fr: "une ou plusieurs photos sont inappropriées, sans rapport avec le bien ou ne vous appartiennent pas",
      ar: "صورة أو أكثر غير لائقة أو لا علاقة لها بالمنتج أو ليست ملكك",
    },
    ground: { type: "terms", ref: `${LISTING_RULES}, photos` },
  },
  category: {
    label: "Plusieurs biens, mauvaise catégorie ou ville",
    facts: {
      fr: "l'annonce ne concerne pas un seul bien ou service, ou n'est pas dans la bonne catégorie ou la bonne ville",
      ar: "الإعلان لا يخص منتجًا أو خدمة واحدة، أو ليس في الفئة أو المدينة الصحيحة",
    },
    ground: { type: "terms", ref: `${LISTING_RULES}, catégorie et ville` },
  },
  scam: {
    label: "Suspicion d'arnaque",
    facts: {
      fr: "l'annonce présente des signes d'arnaque (paiement d'avance, prix irréaliste, contact hors de Joutiya)",
      ar: "يحمل الإعلان مؤشرات احتيال (دفع مسبق، سعر غير واقعي، تواصل خارج Joutiya)",
    },
    ground: { type: "terms", ref: "CGU « Modération », risque d'arnaque" },
  },
  pro_as_individual: {
    label: "Professionnel en compte particulier",
    facts: { fr: "l'annonce relève d'une activité professionnelle publiée depuis un compte de particulier", ar: "الإعلان يتعلق بنشاط مهني نُشر من حساب فرد" },
    ground: { type: "terms", ref: "CGU « Inscription et comptes », compte Pro" },
  },
  spam: {
    label: "Spam ou publicité",
    facts: {
      fr: "l'annonce est un contenu indésirable (annonce répétée, aucun bien réel, publicité pour un autre site ou un service sans rapport)",
      ar: "الإعلان محتوى غير مرغوب فيه (إعلان مكرر، لا يوجد غرض حقيقي، إشهار لموقع آخر أو لخدمة لا علاقة لها بالفئة)",
    },
    ground: { type: "terms", ref: `${LISTING_RULES}, spam` },
  },
  other: {
    label: "Autre motif (à préciser)",
    facts: { fr: "autre manquement aux conditions d'utilisation", ar: "إخلال آخر بشروط الاستخدام" },
    ground: { type: "terms", ref: LISTING_RULES },
    detailsRequired: true,
  },
};

/** Ground of an approval: the automated hold is lifted after a human review. */
export const APPROVAL_GROUND = { type: "terms", ref: LISTING_RULES } as const;

/** Statement facts carry reason codes with this prefix; the mail translates them. */
export const REASON_FACT_PREFIX = "reason:";

/** Facts of a rejection statement: the reason code, then the moderator's words (sent as written). */
export function rejectStatementFacts(reason: RejectReasonCode, details?: string): string[] {
  return [`${REASON_FACT_PREFIX}${reason}`, ...(details ? [details] : [])];
}

/** The seller-facing sentence of a `reason:<code>` fact, or undefined for any other fact. */
export function reasonFactText(fact: string, lang: "fr" | "ar"): string | undefined {
  if (!fact.startsWith(REASON_FACT_PREFIX)) return undefined;
  const code = fact.slice(REASON_FACT_PREFIX.length);
  return (REJECT_REASON_CODES as readonly string[]).includes(code) ? REJECT_REASONS[code as RejectReasonCode].facts[lang] : undefined;
}

/** Short French labels of the pre-moderation flags (back office). */
export const FLAG_LABELS: Record<ModerationFlag, string> = {
  prohibited_kw: "Mot-clé interdit",
  prohibited_soft: "Vocabulaire à risque",
  sensitive_text: "Données sensibles",
  third_party_phone: "Numéro d'un tiers",
  face: "Visage",
  nsfw_review: "Photo à vérifier",
  price_outlier: "Prix inhabituel",
  dup_text: "Texte en double",
  dup_photo: "Photo en double",
  new_account: "Compte récent",
  volume: "Volume élevé",
  restricted_category: "Catégorie réservée aux majeurs",
  credit_ad: "Mensualité sans TEG",
  sanitary_check: "N° ONSSA à vérifier",
  rental_review: "Location à vérifier",
  promo_check: "Promotion de plus de 70 %",
};

export const DECISION_TEXT_MAX = 500;
/** "Autre motif" needs a real sentence. */
export const DECISION_DETAILS_MIN = 10;

const versionSchema = z.number().int().min(0);
const textSchema = z.string().trim().max(DECISION_TEXT_MAX);

/**
 * POST /api/admin/moderation/{id}. `version` is the listing version the moderator reviewed: a
 * concurrent edit or decision makes the request fail (409) instead of deciding on stale content.
 * `details` of a rejection is quoted to the seller; `note` of an approval is kept in the decision record, never mailed.
 */
export const moderationDecisionRequestSchema = z
  .discriminatedUnion("action", [
    z.object({ action: z.literal("approve"), version: versionSchema, note: textSchema.optional() }).strict(),
    z.object({ action: z.literal("reject"), version: versionSchema, reason: z.enum(REJECT_REASON_CODES), details: textSchema.optional() }).strict(),
  ])
  .superRefine((input, ctx) => {
    if (input.action === "reject" && REJECT_REASONS[input.reason].detailsRequired && (input.details ?? "").length < DECISION_DETAILS_MIN) {
      ctx.addIssue({ code: "custom", path: ["details"], message: "required" });
    }
  });
export type ModerationDecisionRequest = z.infer<typeof moderationDecisionRequestSchema>;

export interface ModerationDecisionResponse {
  /** After an approval: published, or paused / expired when the held edit's listing was (lifecycle `approvalOutcome`). */
  status: "published" | "paused" | "expired" | "rejected";
  decisionId: string;
}
