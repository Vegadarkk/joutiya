import "server-only";
import { createHash } from "node:crypto";
import { reportReason } from "@/config/report-reasons";
import { HIDDEN_MARKER } from "@/lib/contracts/messaging";
import { getListing, type ListingRecord } from "@/lib/db/repositories/listings";
import { getModerationDecision } from "@/lib/db/repositories/moderation-decisions";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import { logger } from "@/lib/logging/logger";
import { openImage } from "@/lib/media/sharp-setup";
import { mediaObjectKey } from "@/lib/media/urls";
import { containsProhibited } from "@/lib/moderation/prohibited";
import { consume } from "@/lib/quota";
import { getReport, type ReportRecord } from "@/lib/reports/repository";
import { evidenceRef, messageRef, readConversationFacts } from "@/lib/reports/targets";
import { splitMessageId } from "@/lib/reports/target-key";
import { objectStore, type ObjectStore } from "@/lib/storage";
import { maskPii } from "./mask";
import type { AiImage, AiTarget, AiTask, AiTaskInput, ListingFacts } from "./types";

// What each task sends (design D19): the masked content only. Listing: category, city, price,
// condition, title, description, the pre-moderation flags and up to 3 photos (variant "s",
// re-encoded JPEG <= 1000 px). Report: reason, the reporter's explanation and the reported content
// (a message: that one message only, never the conversation). Appeal: the decision and the
// appellant's text. Names of the people involved are masked with phones, e-mails and links.

export const MAX_IMAGES = 3;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_EDGE = 1000;

export interface ImageLoader {
  (listing: ListingRecord): Promise<AiImage[]>;
}

/** Variant "s" of the first photos, re-encoded to JPEG; a photo that fails is left out. */
export async function loadListingImages(listing: ListingRecord, store: ObjectStore = objectStore()): Promise<AiImage[]> {
  const images: AiImage[] = [];
  for (const photo of listing.photos.slice(0, MAX_IMAGES)) {
    try {
      const body = await store.get("media", mediaObjectKey(listing.id, photo.id, "s"), { maxBytes: IMAGE_MAX_BYTES });
      if (!body || body.length > IMAGE_MAX_BYTES) continue;
      const jpeg = await openImage(body).rotate().resize({ width: IMAGE_EDGE, height: IMAGE_EDGE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      images.push({ mediaType: "image/jpeg", data: jpeg.toString("base64") });
    } catch (error) {
      logger.warn({ listingId: listing.id, photoId: photo.id, err: (error as Error).message }, "ai: listing photo left out");
    }
  }
  return images;
}

export function inputHash(task: AiTask, target: AiTarget, text: string, images: readonly AiImage[]): string {
  const hash = createHash("sha256").update(`${task}\n${target.type}:${target.id}\n${text}`);
  for (const image of images) hash.update("\n").update(image.data);
  return hash.digest("hex");
}

function listingLines(listing: ListingRecord, names: readonly string[]): string[] {
  const price = listing.isDonation ? "don (gratuit)" : listing.price === null ? "à discuter" : `${listing.price} MAD${listing.priceNegotiable ? " (négociable)" : ""}`;
  return [
    `Vendeur : ${listing.sellerType === "pro" ? "professionnel" : "particulier"}`,
    `Catégorie : ${listing.categoryId ?? "?"} / ${listing.subcategoryId ?? "?"}`,
    `Ville : ${listing.location?.citySlug ?? "?"}`,
    `Prix : ${price}`,
    ...(listing.condition ? [`État : ${listing.condition}`] : []),
    `Titre : ${maskPii(listing.title, names)}`,
    `Description :\n${maskPii(listing.description, names)}`,
  ];
}

function listingFacts(listing: ListingRecord): ListingFacts {
  return {
    kind: "listing",
    status: listing.status,
    version: listing.version,
    flags: listing.moderation.flags,
    score: listing.moderation.score,
    hidden: Boolean(listing.moderation.hiddenBy),
    openReports: listing.moderation.openReports,
    prohibitedHard: containsProhibited(`${listing.title}\n${listing.description}`).hard,
  };
}

export interface InputDeps {
  images?: ImageLoader;
}

/** Screening input of a held listing or of one published by the automated screening; null otherwise. */
export async function listingScreenInput(listingId: string, deps: InputDeps = {}): Promise<{ input: AiTaskInput; listing: ListingRecord } | null> {
  const listing = await getListing(listingId);
  if (!listing || (listing.status !== "pending_review" && listing.status !== "published")) return null;
  // Published: only what the automated pre-moderation let through (D20); a moderator's approval stands.
  if (listing.status === "published" && listing.moderation.state !== "auto_ok") return null;
  const names = [listing.sellerName];
  const text = [
    "Annonce à examiner.",
    ...listingLines(listing, names),
    `Signaux de la pré-modération : ${listing.moderation.flags.join(", ") || "aucun"}`,
  ].join("\n");
  const images = await (deps.images ?? loadListingImages)(listing);
  const target: AiTarget = { type: "listing", id: listing.id };
  return {
    listing,
    input: { task: "listing_screen", target, text, images, facts: listingFacts(listing), inputHash: inputHash("listing_screen", target, text, images) },
  };
}

/** The reported message only (original when masked or hidden), with the participants' names. */
async function reportedMessage(id: string): Promise<{ text: string; names: string[] } | null> {
  const ids = splitMessageId(id);
  if (!ids) return null;
  const [conversation, message, evidence] = await Promise.all([readConversationFacts(ids.cid), messageRef(ids.cid, ids.mid).get(), evidenceRef(ids.cid, ids.mid).get()]);
  void consume("firestore.reads", 2);
  const stored: unknown = message.get("text");
  const original: unknown = evidence.exists ? evidence.get("text") : undefined;
  const text = typeof original === "string" ? original : typeof stored === "string" && stored !== HIDDEN_MARKER ? stored : null;
  if (text === null) return null;
  const names: string[] = [];
  if (conversation) {
    const [seller, buyer] = await Promise.all([getUserRecord(conversation.sellerUid), getUserRecord(conversation.buyerUid)]);
    for (const user of [seller, buyer]) if (user) names.push(user.displayName);
  }
  return { text, names };
}

/** Triage input of an open report; null when the report is gone or closed. */
export async function reportTriageInput(reportId: string, deps: InputDeps = {}): Promise<{ input: AiTaskInput; report: ReportRecord } | null> {
  const report = await getReport(reportId);
  if (!report || (report.status !== "open" && report.status !== "in_review")) return null;
  const reason = reportReason(report.reasonId);
  const names: string[] = [report.reporter.name ?? ""];
  const lines = [
    `Signalement de ${report.target.type === "listing" ? "une annonce" : report.target.type === "message" ? "un message privé" : "un profil"}.`,
    `Motif choisi : ${report.reasonId} (${report.priority}${reason ? `, ${reason.label.fr}` : ""})`,
    `Origine : ${report.source === "user" ? "utilisateur" : report.source === "system" ? "règle automatique" : "autorité"}`,
  ];
  let images: AiImage[] = [];
  if (report.target.type === "listing") {
    const listing = await getListing(report.target.id);
    if (listing) {
      names.push(listing.sellerName);
      lines.push("Contenu signalé (annonce) :", ...listingLines(listing, names));
      images = await (deps.images ?? loadListingImages)(listing);
    } else {
      lines.push("Contenu signalé : annonce introuvable.");
    }
  } else if (report.target.type === "message") {
    const message = await reportedMessage(report.target.id);
    if (message) names.push(...message.names);
    lines.push(`Contenu signalé (un seul message) :\n${message ? maskPii(message.text, names) : "message introuvable."}`);
  } else {
    lines.push("Contenu signalé : profil d'un membre (pas de contenu joint).");
  }
  lines.push(`Explication du signalant :\n${maskPii(report.explanation, names)}`);
  const text = lines.join("\n");
  const target: AiTarget = { type: "report", id: report.id };
  return {
    report,
    input: {
      task: "report_triage",
      target,
      text,
      images,
      facts: { kind: "report", reasonId: report.reasonId, priority: report.priority, targetType: report.target.type, status: report.status },
      inputHash: inputHash("report_triage", target, text, images),
    },
  };
}

/** Review input of a decision under appeal; null when the decision is gone or has no open appeal. */
export async function appealReviewInput(decisionId: string): Promise<{ input: AiTaskInput } | null> {
  const decision = await getModerationDecision(decisionId);
  if (decision?.appeal?.status !== "open") return null;
  const affected = await getUserRecord(decision.affectedUid);
  const names = [affected?.displayName ?? ""];
  const lines = [
    "Recours contre une décision de modération.",
    `Mesure : ${decision.action}${decision.durationDays ? ` (${decision.durationDays} jours)` : ""}, cible : ${decision.target.type}`,
    `Décision automatisée : ${decision.automation.decision ? "oui" : "non"}`,
    `Fondement : ${decision.ground.type === "illegal" ? "contenu illicite" : "conditions d'utilisation"} (${decision.ground.ref})`,
    `Faits retenus :\n${maskPii(decision.facts, names)}`,
    `Explication :\n${maskPii(decision.ground.explanation, names)}`,
  ];
  if (decision.target.type === "listing") {
    const listing = await getListing(decision.target.id);
    if (listing) {
      names.push(listing.sellerName);
      lines.push("Annonce concernée :", ...listingLines(listing, names));
    }
  }
  lines.push(`Recours (${decision.appeal.by === "reporter" ? "par le signalant" : "par la personne concernée"}) :\n${maskPii(decision.appeal.text ?? "", names)}`);
  const text = lines.join("\n");
  const target: AiTarget = { type: "decision", id: decision.id };
  return {
    input: {
      task: "appeal_review",
      target,
      text,
      images: [],
      facts: { kind: "appeal", action: decision.action, appealStatus: decision.appeal.status },
      inputHash: inputHash("appeal_review", target, text, []),
    },
  };
}
