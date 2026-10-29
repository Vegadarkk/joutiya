import "server-only";
import {
  DEFAULT_SELLER_PAYMENTS,
  isAllowedPaymentHost,
  PAYMENT_LINK_DELAY_MS,
  PAYMENT_LINK_RECENT_AUTH_SECONDS,
  parsePaymentLink,
  resolveSellerPaymentsConfig,
  sellerPaymentsConfigSchema,
  type SellerPaymentsConfig,
} from "@/config/seller-payments";
import { isRecentSignIn } from "@/lib/account/rules";
import { audit } from "@/lib/audit";
import type { AuthContext, StaffContext } from "@/lib/auth/guards";
import { getSellerPayments } from "@/lib/config/runtime";
import {
  SELLER_TERMS_VERSION,
  type OpenPaymentResponse,
  type PaymentHostQueueItem,
  type PublicShopPayment,
  type SellerPaymentInput,
  type SellerPaymentsAdminView,
  type SellerPaymentView,
  type ShopPaymentAdminView,
} from "@/lib/contracts/seller-payment";
import { getListing } from "@/lib/db/repositories/listings";
import { incrementPaymentClicks } from "@/lib/db/repositories/listing-stats";
import { getProProfile, listPaymentHostReview, listPendingPaymentHost, proProfileRef, proProfileToFirestore, type ProProfileRecord } from "@/lib/db/repositories/pro-profiles";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import { db, isFirestoreConfigured } from "@/lib/firebase/admin";
import { HttpError, notFound } from "@/lib/http/errors";
import { acceptsContact, isPubliclyVisible, isVisibleAccount, storefrontSegment } from "@/lib/listings/public";
import { revalidateListingPaths } from "@/lib/listings/revalidate";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import type { TemplateData } from "@/lib/mail/types";
import { listingRecipient } from "@/lib/mail/recipients";
import { consume, firstDegraded } from "@/lib/quota";
import { consumeLimit } from "@/lib/rate-limit/limiter";
import type { ListingPaymentLink } from "@/lib/db/schemas";
import type { SellerPaymentDoc } from "./profile-schema";
import { effectivePayment, foldPending, paymentEligible, paymentShown } from "./seller-payment-rules";

// « Payer chez le vendeur » (owner decision 2026-10-28, design phase-7/boutique-temporaire.md §2):
// - the owner of a verified shop saves a link to its own payment page and/or cash on delivery,
//   with the seller information of law 31-08; a new link needs a recent sign-in, is mailed to the
//   owner and turns active 24 hours later, once its host is on `config/sellerPayments.hosts`;
// - a host not on the list waits for an admin's review (approve adds it, reject drops the link);
// - the public button asks for the link at click time (`openShopPayment`): state, suspension and
//   allowlist are checked then, so withdrawing a host or suspending a shop hides every button at
//   once whatever the cached pages show; only an aggregate click counter is kept per listing;
// - a moderator suspends or restores a shop's button (report « Lien de paiement suspect »).
// The server never fetches a link and adds nothing to it (no tracking, no commission).

const ownerOnly = (auth: AuthContext): string => {
  const { proId, proRole } = auth.user.claims;
  if (!proId) throw notFound();
  if (proRole !== "owner") throw new HttpError(403, "forbidden", "shop owner only");
  return proId;
};

async function ownProfile(auth: AuthContext): Promise<ProProfileRecord> {
  const proId = ownerOnly(auth);
  const profile = await getProProfile(proId);
  if (!profile || profile.ownerUid !== auth.user.uid) throw notFound();
  return profile;
}

function ownerView(profile: ProProfileRecord, config: SellerPaymentsConfig, now: Date): SellerPaymentView {
  const payment = profile.sellerPayment;
  const effective = effectivePayment(payment, config, now);
  return {
    eligible: paymentEligible(profile.lifecycle, profile.plan),
    shopName: profile.name,
    ice: profile.legal.ice,
    url: effective.url,
    // Kept while its host is off the list (the form must not drop it at the next save).
    storedUrl: payment ? (foldPending(payment, config, now).url ?? null) : null,
    pending: effective.pending ? { url: effective.pending.url, host: effective.pending.host, activeFrom: effective.pending.activeFrom?.toISOString() ?? null, review: effective.pending.activeFrom === null } : null,
    hostRejected: payment?.hostRejected ? { host: payment.hostRejected.host, reason: payment.hostRejected.reason, at: payment.hostRejected.at.toISOString() } : null,
    cashOnDelivery: payment?.cashOnDelivery ?? false,
    info: payment?.info ?? null,
    suspended: payment?.suspendedAt ? { reason: payment.suspendedReason ?? "", at: payment.suspendedAt.toISOString() } : null,
    termsVersion: SELLER_TERMS_VERSION,
  };
}

export async function sellerPaymentSettings(auth: AuthContext, now = new Date()): Promise<SellerPaymentView> {
  const [profile, config] = await Promise.all([ownProfile(auth), getSellerPayments()]);
  return ownerView(profile, config, now);
}

/** Saves the owner's settings (PUT /api/pro/me/payment). */
export async function saveSellerPayment(auth: AuthContext, input: SellerPaymentInput, now = new Date()): Promise<SellerPaymentView> {
  const proId = ownerOnly(auth);
  const config = await getSellerPayments();
  const parsedLink = input.url === null ? null : parsePaymentLink(input.url);
  if (parsedLink && "problem" in parsedLink) throw new HttpError(422, "payment_link_invalid", "payment link refused", { details: { problem: parsedLink.problem } });
  const link = parsedLink && "host" in parsedLink ? parsedLink : null;
  const turningOn = link !== null || input.cashOnDelivery;
  if (turningOn && (!input.info || !input.acceptTerms)) throw new HttpError(422, "payment_info_required");

  const result = await db().runTransaction(async (tx) => {
    const profile = await getProProfile(proId, tx);
    if (!profile || profile.ownerUid !== auth.user.uid) throw notFound();
    if (!paymentEligible(profile.lifecycle, profile.plan)) throw new HttpError(409, "pro_not_verified");
    const before = profile.sellerPayment ? foldPending(profile.sellerPayment, config, now) : undefined;
    // The same pending link keeps its delay; going back to the active link cancels the pending one
    // (neither can divert a payment); any other link is a change.
    const keepsPending = link !== null && link.url === before?.pendingUrl;
    const backToActive = link !== null && !keepsPending && link.url === before?.url;
    const changed = link !== null && !keepsPending && !backToActive;
    // The contact buyers write to (e-mail, address) is as sensitive as the link: same sign-in rule, and the owner is told.
    const contactChanged = input.info !== null && before?.info !== undefined && (input.info.email !== before.info.email || input.info.address !== before.info.address);
    if ((changed || contactChanged) && !isRecentSignIn(auth.user.authTime, now, PAYMENT_LINK_RECENT_AUTH_SECONDS)) throw new HttpError(403, "recent_auth_required");

    let next: SellerPaymentDoc = {
      ...(before ?? {}),
      cashOnDelivery: input.cashOnDelivery,
      updatedAt: now,
    };
    if (input.info) next.info = input.info;
    if (link === null || backToActive) {
      // Removal is immediate (it cannot divert a payment).
      const { url, pendingUrl: _pending, pendingFrom: _from, pendingHost: _host, hostReview: _review, ...rest } = next;
      next = backToActive && url ? { ...rest, url } : rest;
    } else if (changed) {
      const allowed = isAllowedPaymentHost(link.host, config);
      const { hostRejected: _rejected, ...rest } = next;
      next = { ...rest, pendingUrl: link.url, pendingFrom: now, pendingHost: link.host, ...(allowed ? {} : { hostReview: true }) };
      if (allowed) delete next.hostReview;
    }
    tx.set(proProfileRef(proId), proProfileToFirestore({ ...withoutId(profile), sellerPayment: next, updatedAt: now }));
    const removed = link === null && (before?.url !== undefined || before?.pendingUrl !== undefined);
    return { profile: { ...profile, sellerPayment: next }, changed, contactChanged, removed, host: link?.host ?? null, allowed: link ? isAllowedPaymentHost(link.host, config) : false };
  });

  void consume("firestore.writes", 1);
  const { profile } = result;
  await audit({ actorUid: auth.user.uid, actorRole: "pro", action: "pro.payment.updated", target: { type: "pro", id: proId }, automated: false, reason: [result.changed ? `link: ${result.host}` : result.removed ? "link removed" : "settings", ...(result.contactChanged ? ["contact"] : [])].join(", "), at: now }).catch(
    (error: unknown) => logger.error({ proId, err: (error as Error).message }, "payment audit failed"),
  );
  if (result.changed) await notifyOwner(profile, { kind: "changed", host: result.host!, activeFrom: result.allowed ? new Date(now.getTime() + PAYMENT_LINK_DELAY_MS).toISOString() : null }, `changed-${now.getTime()}`);
  else if (result.removed) await notifyOwner(profile, { kind: "removed" }, `removed-${now.getTime()}`);
  if (result.contactChanged) await notifyOwner(profile, { kind: "contact" }, `contact-${now.getTime()}`);
  revalidateShop(profile);
  return ownerView(profile, config, now);
}

function withoutId(profile: ProProfileRecord) {
  const { proId: _proId, ...doc } = profile;
  return doc;
}

function revalidateShop(profile: ProProfileRecord): void {
  revalidateListingPaths({ shopSegment: storefrontSegment(profile.slug, profile.proId) });
}

/** Tells the shop's owner of a change of its payment button (a listing's own link included). Never throws. */
export async function notifyOwner(profile: Pick<ProProfileRecord, "proId" | "ownerUid" | "name">, data: Omit<TemplateData["sellerPaymentNotice"], "displayName" | "shopName">, key: string): Promise<void> {
  try {
    const to = await listingRecipient(profile.ownerUid);
    if (!to) return;
    await sendMail({
      template: "sellerPaymentNotice",
      locale: to.locale,
      to: to.email,
      priority: "transactional",
      idempotencyKey: `seller-payment-${profile.proId}-${key}`,
      data: { displayName: to.displayName, shopName: profile.name, ...data },
    });
  } catch (error) {
    logger.error({ proId: profile.proId, err: (error as Error).message }, "seller payment mail not sent");
  }
}

/**
 * The link a buyer's click opens: the listing's own one in force (catalogue §6), else the shop's.
 * Both follow the same rules (24 h delay, host on the allowlist now).
 */
function linkInForce(profile: ProProfileRecord, config: SellerPaymentsConfig, now: Date, listingLink?: ListingPaymentLink): { url: string | null; host: string | null } {
  const own = listingLink ? effectivePayment(listingLink, config, now) : null;
  if (own?.url) return { url: own.url, host: own.host };
  const shop = effectivePayment(profile.sellerPayment, config, now);
  return { url: shop.url, host: shop.host };
}

/** What a public page shows of the shop's payment, or null (no button, no badge). */
export function publicShopPayment(profile: ProProfileRecord, config: SellerPaymentsConfig, now: Date, listingLink?: ListingPaymentLink): PublicShopPayment | null {
  const payment = profile.sellerPayment;
  if (!payment || !paymentShown(profile.lifecycle, profile.plan, payment) || !payment.info) return null;
  const link = linkInForce(profile, config, now, listingLink);
  if (!link.url && !payment.cashOnDelivery) return null;
  return { proId: profile.proId, shopName: profile.name, ice: profile.legal.ice, online: link.url !== null, host: link.host, cashOnDelivery: payment.cashOnDelivery, info: payment.info };
}

/** The shop's payment for a listing (with its own link) or storefront page; never throws (the page renders without it). */
export async function shopPaymentFor(proId: string | undefined, now = new Date(), listingLink?: ListingPaymentLink): Promise<PublicShopPayment | null> {
  if (!proId) return null;
  try {
    const [profile, config] = await Promise.all([getProProfile(proId), getSellerPayments()]);
    if (!profile?.sellerPayment || !(await ownerShown(profile))) return null;
    return publicShopPayment(profile, config, now, listingLink);
  } catch (error) {
    logger.warn({ proId, err: (error as Error).message }, "shop payment lookup failed");
    return null;
  }
}

/** The owner's account has a public face and is not suspended (as for the storefront). */
async function ownerShown(profile: ProProfileRecord): Promise<boolean> {
  const user = await getUserRecord(profile.ownerUid);
  return user !== null && isVisibleAccount(user) && user.status !== "suspended";
}

/** The link to open now (POST /api/shops/{proId}/payment), checked at click time; `visitor` is the caller's IP bucket. */
export async function openShopPayment(proId: string, listingId: string | undefined, visitor: string, now = new Date()): Promise<OpenPaymentResponse> {
  const [profile, config, listing] = await Promise.all([getProProfile(proId), getSellerPayments(), listingId ? getListing(listingId).catch(() => null) : Promise.resolve(null)]);
  if (!profile) throw notFound();
  // Only the shop's own published listing, shown and contactable (not hidden by moderation, not an
  // example), brings its link (and counts a click).
  const own = listing && listing.ownerUid === profile.ownerUid && isPubliclyVisible(listing) && acceptsContact(listing) ? listing : null;
  const shown = publicShopPayment(profile, config, now, own?.paymentLink);
  const link = linkInForce(profile, config, now, own?.paymentLink);
  if (!shown?.online || !link.url || !link.host || !(await ownerShown(profile))) throw new HttpError(404, "payment_unavailable");
  if (own) await countClick(own.id, visitor, now);
  return { url: link.url, host: link.host, shopName: profile.name, ice: profile.legal.ice };
}

/**
 * One click per visitor, listing and day, on the shop's own published listings, while the write
 * quota is not degraded. Never blocks the payment.
 */
async function countClick(listingId: string, visitor: string, now: Date): Promise<void> {
  try {
    if (!(await consumeLimit("shop.payment.click", `${visitor}:${listingId}`)).ok) return;
    if (await firstDegraded(["firestore.writes"])) return;
    await incrementPaymentClicks(listingId, now);
  } catch (error) {
    logger.warn({ listingId, err: (error as Error).message }, "payment click not counted");
  }
}

// Back office.

const CONFIG_DOC = () => db().collection("config").doc("sellerPayments");
const QUEUE_LIMIT = 100;

/** The stored list, read now: a failed read throws (an admin must never edit a fallback list). */
async function storedConfig(): Promise<SellerPaymentsConfig> {
  if (!isFirestoreConfigured()) return DEFAULT_SELLER_PAYMENTS;
  const snapshot = await CONFIG_DOC().get();
  void consume("firestore.reads", 1);
  return resolveSellerPaymentsConfig(snapshot.exists ? snapshot.data() : undefined).config;
}

export async function sellerPaymentsAdmin(now = new Date()): Promise<SellerPaymentsAdminView> {
  const [config, waiting] = await Promise.all([storedConfig(), isFirestoreConfigured() ? listPaymentHostReview(QUEUE_LIMIT) : Promise.resolve([])]);
  const queue: PaymentHostQueueItem[] = waiting
    .filter((profile) => profile.sellerPayment?.pendingUrl && profile.sellerPayment.pendingHost && profile.sellerPayment.pendingFrom)
    .map((profile) => ({ proId: profile.proId, shopName: profile.name, host: profile.sellerPayment!.pendingHost!, url: profile.sellerPayment!.pendingUrl!, since: profile.sellerPayment!.pendingFrom!.toISOString() }))
    .sort((a, b) => a.since.localeCompare(b.since));
  void now;
  return { hosts: config.hosts, queue };
}

async function writeHosts(staff: StaffContext, hosts: string[], reason: string, now: Date): Promise<SellerPaymentsConfig> {
  const parsed = sellerPaymentsConfigSchema.safeParse({ hosts: [...new Set(hosts)].sort() });
  if (!parsed.success) throw new HttpError(400, "invalid_body", parsed.error.issues[0]?.message ?? "invalid hosts");
  await CONFIG_DOC().set({ ...parsed.data, updatedAt: now, updatedBy: staff.user.uid });
  void consume("firestore.writes", 1);
  getSellerPayments.invalidate();
  await audit({ actorUid: staff.user.uid, actorRole: staff.role, action: "config.sellerPayments.updated", target: { type: "config", id: "sellerPayments" }, automated: false, reason: reason.slice(0, 500), at: now });
  return parsed.data;
}

/** Replaces the allowlist (PUT /api/admin/seller-payments): a host taken off hides its buttons at once. */
export async function saveSellerPaymentHosts(staff: StaffContext, hosts: string[], now = new Date()): Promise<SellerPaymentsAdminView> {
  const before = await storedConfig();
  const added = hosts.filter((host) => !before.hosts.includes(host));
  const removed = before.hosts.filter((host) => !hosts.includes(host));
  await writeHosts(staff, hosts, `+[${added.join(", ")}] -[${removed.join(", ")}]`, now);
  for (const host of added) await setReview(host, false);
  // A link waiting on a host taken off goes back to the review queue.
  for (const host of removed) await setReview(host, true);
  return sellerPaymentsAdmin(now);
}

/** Approves a waiting host (added to the list: its links turn active 24 h after their save) or rejects it (the links are dropped). */
export async function reviewPaymentHost(staff: StaffContext, input: { host: string; decision: "approve" | "reject"; reason?: string }, now = new Date()): Promise<SellerPaymentsAdminView> {
  const config = await storedConfig();
  if (input.decision === "approve") {
    if (!config.hosts.includes(input.host)) await writeHosts(staff, [...config.hosts, input.host], `+[${input.host}] (review)`, now);
    await setReview(input.host, false);
    return sellerPaymentsAdmin(now);
  }
  const shops = await listPendingPaymentHost(input.host, QUEUE_LIMIT);
  for (const shop of shops) {
    const rejected = await db().runTransaction(async (tx) => {
      const profile = await getProProfile(shop.proId, tx);
      const payment = profile?.sellerPayment;
      if (!profile || !payment || payment.pendingHost !== input.host) return null;
      const { pendingUrl: _url, pendingFrom: _from, pendingHost: _host, hostReview: _review, ...rest } = payment;
      const next: SellerPaymentDoc = { ...rest, hostRejected: { host: input.host, reason: input.reason!, at: now }, updatedAt: now };
      tx.set(proProfileRef(profile.proId), proProfileToFirestore({ ...withoutId(profile), sellerPayment: next, updatedAt: now }));
      return profile;
    });
    if (!rejected) continue;
    await audit({ actorUid: staff.user.uid, actorRole: staff.role, action: "pro.payment.host_rejected", target: { type: "pro", id: rejected.proId }, automated: false, reason: `${input.host}: ${input.reason}`.slice(0, 500), at: now });
    await notifyOwner(rejected, { kind: "rejected", host: input.host, reason: input.reason! }, `rejected-${input.host}-${now.getTime()}`);
  }
  return sellerPaymentsAdmin(now);
}

/** The pending links on `host` leave the review queue (false: they turn active by the usual 24 h rule) or join it (true). */
async function setReview(host: string, review: boolean): Promise<void> {
  const shops = await listPendingPaymentHost(host, QUEUE_LIMIT);
  for (const shop of shops) {
    if ((shop.sellerPayment?.hostReview ?? false) === review) continue;
    await proProfileRef(shop.proId).update({ "sellerPayment.hostReview": review });
    void consume("firestore.writes", 1);
  }
}

export async function shopPaymentAdmin(proId: string, now = new Date()): Promise<ShopPaymentAdminView> {
  const [profile, config] = await Promise.all([getProProfile(proId), getSellerPayments()]);
  if (!profile) throw notFound();
  const payment = profile.sellerPayment;
  return {
    url: effectivePayment(payment, config, now).url,
    pendingUrl: payment?.pendingUrl ?? null,
    cashOnDelivery: payment?.cashOnDelivery ?? false,
    suspended: payment?.suspendedAt ? { reason: payment.suspendedReason ?? "", at: payment.suspendedAt.toISOString() } : null,
  };
}

/** A moderator cuts or restores a shop's button (its listings stay online). */
export async function setShopPaymentSuspension(staff: StaffContext, proId: string, input: { action: "suspend" | "restore"; reason: string }, now = new Date()): Promise<ShopPaymentAdminView> {
  const profile = await db().runTransaction(async (tx) => {
    const current = await getProProfile(proId, tx);
    if (!current) throw notFound();
    const payment = current.sellerPayment;
    if (!payment) throw new HttpError(409, "conflict", "the shop has no payment button");
    const suspended = payment.suspendedAt !== undefined;
    if ((input.action === "suspend") === suspended) return null;
    const { suspendedAt: _at, suspendedReason: _reason, ...rest } = payment;
    const next: SellerPaymentDoc = input.action === "suspend" ? { ...rest, suspendedAt: now, suspendedReason: input.reason, updatedAt: now } : { ...rest, updatedAt: now };
    tx.set(proProfileRef(proId), proProfileToFirestore({ ...withoutId(current), sellerPayment: next, updatedAt: now }));
    return { ...current, sellerPayment: next };
  });
  if (profile) {
    await audit({ actorUid: staff.user.uid, actorRole: staff.role, action: input.action === "suspend" ? "pro.payment.suspended" : "pro.payment.restored", target: { type: "pro", id: proId }, automated: false, reason: input.reason, at: now });
    await notifyOwner(profile, input.action === "suspend" ? { kind: "suspended", reason: input.reason } : { kind: "restored" }, `${input.action}-${now.getTime()}`);
    revalidateShop(profile);
  }
  return shopPaymentAdmin(proId, now);
}
