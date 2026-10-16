import "server-only";
import type { AuthContext } from "@/lib/auth/guards";
import type { Device } from "@/lib/auth/respond";
import { alert } from "@/lib/alert";
import type { PhoneRevealResponse } from "@/lib/contracts/listings";
import { incrementPhoneReveals } from "@/lib/db/repositories/listing-stats";
import { getListing } from "@/lib/db/repositories/listings";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import { countRevealsSince, hasRevealed, recordReveal } from "@/lib/db/repositories/reveal-logs";
import { getUserPrivate } from "@/lib/db/repositories/users";
import { HttpError, notFound } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { displayPhone } from "@/lib/phone/normalize";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { escalateOnIp } from "./escalation";

// Phone reveal (§6 "/api/listings/[id]/phone"): a signed-in account older than 24 hours with a
// verified e-mail; 10/h and 30/day per uid, 20/day per device, 60/day per IP then Turnstile; every
// limiter closed (Valkey down = refused). The number never sits in the HTML: this is the only path
// to it, logged in revealLogs (90 days) and counted in listingStats.

export const MIN_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000;
/** Reveals of one listing in a day past which the owner is told (§6 "aspiration des numéros"). */
export const REVEAL_ALERT_PER_DAY = 100;

export interface RevealOptions {
  turnstileToken?: string;
  device: Device;
  now?: Date;
}

export interface RevealOutcome {
  response: PhoneRevealResponse;
  turnstilePassed: boolean;
}

/** `https://wa.me/<digits>` for an E.164 number. */
export function whatsappUrl(e164: string): string {
  return `https://wa.me/${e164.replace(/\D/g, "")}`;
}

export async function revealPhone(auth: AuthContext, request: Request, listingId: string, options: RevealOptions): Promise<RevealOutcome> {
  const now = options.now ?? new Date();
  const viewer = await getUserRecord(auth.user.uid);
  if (!viewer) throw new HttpError(403, "forbidden", "account record missing");
  const emailVerified = viewer.badges.emailVerified || auth.user.emailVerified;
  if (!emailVerified || now.getTime() - viewer.createdAt.getTime() < MIN_ACCOUNT_AGE_MS) throw new HttpError(403, "reveal_not_allowed");

  const listing = await getListing(listingId);
  if (!listing || listing.status === "removed" || listing.status === "purged" || listing.status === "draft") throw notFound();
  if (listing.status !== "published") throw new HttpError(409, "listing_unavailable");
  if (!listing.contact.showPhone && !listing.contact.whatsapp) throw notFound();

  // A listing this account already revealed does not count again (§6).
  const repeat = await hasRevealed(viewer.uid, listing.id);
  let turnstilePassed = false;
  if (!repeat) {
    await enforceLimit("reveal.uid.hour", viewer.uid);
    await enforceLimit("reveal.uid.day", viewer.uid);
    await enforceLimit("reveal.device", options.device.identity.deviceKey);
    turnstilePassed = await escalateOnIp(request, "reveal.ip", options.device, options.turnstileToken, "listing");
  }

  const [owner, account] = await Promise.all([getUserRecord(listing.ownerUid), getUserPrivate(listing.ownerUid)]);
  if (!owner?.badges.phoneVerified || !account?.phoneE164) throw notFound();

  if (!repeat) {
    await recordReveal({ viewerUid: viewer.uid, listingId: listing.id, ip: options.device.identity.ip, deviceKey: options.device.identity.deviceKey, now });
    await incrementPhoneReveals(listing.id, now);
    void watchScraping(listing.id, now);
  }

  const e164 = account.phoneE164;
  return {
    response: { phone: { e164, display: displayPhone(e164), ...(listing.contact.whatsapp ? { whatsappUrl: whatsappUrl(e164) } : {}) } },
    turnstilePassed,
  };
}

/** Alerts once a listing passes REVEAL_ALERT_PER_DAY reveals in 24 hours (never throws). */
async function watchScraping(listingId: string, now: Date): Promise<void> {
  try {
    const count = await countRevealsSince(listingId, new Date(now.getTime() - 24 * 60 * 60 * 1000));
    if (count === REVEAL_ALERT_PER_DAY) {
      await alert({ severity: "P2", title: `Révélations de numéro anormales : annonce ${listingId}`, body: `${count} révélations en 24 heures sur une seule annonce (seuil ${REVEAL_ALERT_PER_DAY}). Vérifier revealLogs (préfixes IP, appareils).` });
    }
  } catch (error) {
    logger.warn({ err: (error as Error).message, listingId }, "reveal count unavailable");
  }
}
