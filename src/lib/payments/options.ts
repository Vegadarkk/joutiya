import "server-only";
import { FEATURED_DAYS, OPTION_IDS, optionPrice, type OptionId, type PricingConfig } from "@/config/pricing";
import { requireOwner, type AuthContext } from "@/lib/auth/guards";
import { OPTION_CONSENT_VERSION, type BuyOptionInput, type BuyOptionResponse, type ListingOptionsResponse, type OptionOffer, type WalletSummary } from "@/lib/contracts/payments";
import { getListing, getListingTx, updateListingTx, type ListingFieldPatch } from "@/lib/db/repositories/listings";
import { enqueueSearchOutboxTx } from "@/lib/db/repositories/search-outbox";
import { getLedgerEntryTx, getWallet, getWalletTx, recordWalletOperationTx, walletStateAt, type LedgerRecord } from "@/lib/db/repositories/wallets";
import type { ListingDoc, WalletDoc } from "@/lib/db/schemas";
import { getFlags, getPricing } from "@/lib/config/runtime";
import { db } from "@/lib/firebase/admin";
import { HttpError, notFound } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { scheduleBoostExpiry } from "@/lib/search/boosts";
import { notifySearchIndex } from "@/lib/search/queue";
import { WalletError, spendOption, type WalletState } from "./wallet";

// Paid listing options (phase 7 design §5): the immediate bump and À la Une, paid in credits.
// One Firestore transaction debits the wallet (plan credits first, then the balance; the plan's
// À la Une allowance for a 7-day À la Une), writes the ledger entry with the consent, updates the
// listing's boosts and its searchOutbox entry. The ledger id `option_{listingId}_{requestId}`
// makes a retried request a replay, never a second debit. Mentions, featured slots and the end of
// an À la Une come from phase 4 (src/lib/search/boosts.ts).

const DAY_MS = 24 * 60 * 60 * 1000;
/** A bump is refused while the listing sorted from a publication, renewal or bump this recently: it is at the top already. */
export const BUMP_MIN_INTERVAL_MS = 60 * 60 * 1000;

/** `uid`, or `pro_{proId}` for a shop's listing: whose credits pay. */
export function billingAccountId(owner: { ownerUid: string; proId?: string }): string {
  return owner.proId ? `pro_${owner.proId}` : owner.ownerUid;
}

/** The wallet a member manages: the shop's for a Pro owner, otherwise their own. */
export function memberBillingAccount(auth: AuthContext): { accountId: string; kind: "personal" | "shop" } {
  const { uid, claims } = auth.user;
  return claims.proId && claims.proRole === "owner" ? { accountId: `pro_${claims.proId}`, kind: "shop" } : { accountId: uid, kind: "personal" };
}

/**
 * The listing's owner (404 otherwise, never 403: IDOR); a shop's listing is paid from the shop's
 * wallet, by its owner only (an editor, V1.1, gets 403).
 */
function payerOf(auth: AuthContext, listing: Pick<ListingDoc, "ownerUid" | "proId">): string {
  requireOwner(auth, listing);
  if (listing.proId && (auth.user.claims.proId !== listing.proId || auth.user.claims.proRole !== "owner")) throw new HttpError(403, "billing_owner_only");
  return billingAccountId(listing);
}

function promotable(listing: Pick<ListingDoc, "status" | "moderation">): boolean {
  return listing.status === "published" && !listing.moderation.hiddenBy;
}

export function walletSummary(wallet: WalletDoc | null, now: Date): WalletSummary {
  const state = walletStateAt(wallet, now);
  return {
    balance: state.balance,
    planCredits: state.planCredits,
    planCreditsResetsAt: state.planCredits > 0 && wallet?.planCreditsResetsAt ? wallet.planCreditsResetsAt.toISOString() : null,
    featuredAllowance: state.featuredAllowance,
    frozen: state.frozen || state.balance < 0,
  };
}

const usesAllowance = (option: OptionId) => option === "featured7";

/** When a bump of a listing sorted at `sortAt` is accepted again, or null when it is now. */
function bumpAvailableAt(sortAt: Date, now: Date): Date | null {
  const at = sortAt.getTime() + BUMP_MIN_INTERVAL_MS;
  return at > now.getTime() ? new Date(at) : null;
}

function offers(listing: Pick<ListingDoc, "categoryId" | "sortAt">, state: WalletState, pricing: PricingConfig, now: Date): OptionOffer[] {
  const blocked = state.frozen || state.balance < 0;
  return OPTION_IDS.map((id) => {
    const price = optionPrice(id, listing.categoryId, pricing);
    const coveredByAllowance = usesAllowance(id) && state.featuredAllowance > 0;
    const availableAt = id === "bump" ? bumpAvailableAt(listing.sortAt, now) : null;
    return {
      id,
      price,
      days: id === "bump" ? null : FEATURED_DAYS[id],
      coveredByAllowance,
      affordable: !blocked && (coveredByAllowance || state.planCredits + state.balance >= price),
      availableAt: availableAt?.toISOString() ?? null,
    };
  });
}

function boostsView(listing: Pick<ListingDoc, "boosts">, now: Date): BuyOptionResponse["boosts"] {
  const { bumpedAt, featuredUntil } = listing.boosts;
  return { bumpedAt: bumpedAt?.toISOString() ?? null, featuredUntil: featuredUntil && featuredUntil.getTime() > now.getTime() ? featuredUntil.toISOString() : null };
}

/** GET: prices for this listing's category, the wallet, the running boosts. */
export async function listingOptions(auth: AuthContext, listingId: string, now = new Date()): Promise<ListingOptionsResponse> {
  const listing = await getListing(listingId);
  if (!listing) throw notFound();
  const accountId = payerOf(auth, listing);
  const [flags, pricing, wallet] = await Promise.all([getFlags(), getPricing(), getWallet(accountId)]);
  return {
    salesOpen: flags.salesEnabled,
    promotable: promotable(listing),
    options: offers(listing, walletStateAt(wallet, now), pricing, now),
    wallet: walletSummary(wallet, now),
    boosts: boostsView(listing, now),
    consentVersion: OPTION_CONSENT_VERSION,
  };
}

/** The listing patch of an option (version and updatedAt are set by the caller). */
export function optionPatch(listing: Pick<ListingDoc, "boosts">, option: OptionId, now: Date): ListingFieldPatch {
  if (option === "bump") return { boosts: { ...listing.boosts, bumpedAt: now }, sortAt: now, sortSource: "bump" };
  const current = listing.boosts.featuredUntil?.getTime() ?? 0;
  const featuredUntil = new Date(Math.max(now.getTime(), current) + FEATURED_DAYS[option] * DAY_MS);
  return { boosts: { ...listing.boosts, featuredUntil } };
}

class ReplayConflictError extends Error {}

interface Outcome {
  replayed: boolean;
  entry: Pick<LedgerRecord, "delta" | "planCreditsDelta" | "featuredAllowanceDelta">;
  /** The wallet after the purchase (or as it is now, for a replay). */
  wallet: WalletDoc | null;
  boosts: ListingDoc["boosts"];
  featuredUntil?: Date;
}

/**
 * POST: buys `input.optionId` for the listing. 403 `sales_closed` while `salesEnabled` is off,
 * 404 for someone else's listing, 409 `listing_not_promotable` / `bump_too_soon` / `wallet_frozen`,
 * 402 `insufficient_credits`, 409 `conflict` when the request id was used for another option.
 */
export async function buyOption(auth: AuthContext, listingId: string, input: BuyOptionInput, now = new Date()): Promise<BuyOptionResponse> {
  const flags = await getFlags();
  if (!flags.salesEnabled) throw new HttpError(403, "sales_closed");
  const listing = await getListing(listingId);
  if (!listing) throw notFound();
  const accountId = payerOf(auth, listing);
  const pricing = await getPricing();
  const entryId = `option_${listingId}_${input.requestId}`;
  const option = input.optionId;

  let outcome: Outcome;
  try {
    outcome = await db().runTransaction(async (tx): Promise<Outcome> => {
      const previous = await getLedgerEntryTx(tx, accountId, entryId);
      const current = await getListingTx(tx, listingId);
      const wallet = await getWalletTx(tx, accountId);
      if (!current) throw notFound();
      // Turned into a shop listing (or back) since the first read: another wallet pays now.
      if (current.proId !== listing.proId) throw new HttpError(409, "conflict", "listing changed meanwhile, reload it");
      if (previous) {
        if (previous.reason !== "option" || previous.refs.optionId !== option || previous.refs.listingId !== listingId) throw new ReplayConflictError();
        return { replayed: true, entry: previous, wallet, boosts: current.boosts };
      }
      if (!promotable(current)) throw new HttpError(409, "listing_not_promotable");
      if (option === "bump" && bumpAvailableAt(current.sortAt, now)) throw new HttpError(409, "bump_too_soon");
      // Price at the listing's category as read in the transaction (a category edit meanwhile counts).
      const price = optionPrice(option, current.categoryId, pricing);
      const spent = spendOption(walletStateAt(wallet, now), price, { useAllowance: usesAllowance(option) });
      const version = current.version + 1;
      const patch: ListingFieldPatch = { ...optionPatch(current, option, now), version, updatedAt: now };
      updateListingTx(tx, listingId, patch);
      enqueueSearchOutboxTx(tx, listingId, "upsert", version, now);
      const after = recordWalletOperationTx(tx, accountId, entryId, {
        before: wallet,
        state: spent.wallet,
        ledger: spent.ledger,
        entry: { price, refs: { listingId, optionId: option, requestId: input.requestId }, consent: { version: OPTION_CONSENT_VERSION, at: now }, actorUid: auth.user.uid, at: now },
        now,
      });
      const boosts = patch.boosts ?? current.boosts;
      return { replayed: false, entry: spent.ledger, wallet: after, boosts, ...(option === "bump" ? {} : { featuredUntil: boosts.featuredUntil }) };
    });
  } catch (error) {
    if (error instanceof ReplayConflictError) throw new HttpError(409, "conflict", "request id already used for another purchase");
    if (error instanceof WalletError) {
      if (error.code === "frozen") throw new HttpError(409, "wallet_frozen");
      if (error.code === "insufficient") throw new HttpError(402, "insufficient_credits");
    }
    throw error;
  }

  if (!outcome.replayed) {
    await notifySearchIndex([listingId]);
    if (outcome.featuredUntil) await scheduleBoostExpiry(listingId, outcome.featuredUntil, now);
    logger.info({ listingId, option, accountKind: listing.proId ? "shop" : "personal" }, "listing option bought");
  }
  const { entry } = outcome;
  return {
    optionId: option,
    replayed: outcome.replayed,
    cost: { planCredits: -entry.planCreditsDelta, credits: -entry.delta, allowance: -entry.featuredAllowanceDelta },
    wallet: walletSummary(outcome.wallet, now),
    boosts: boostsView({ boosts: outcome.boosts }, now),
  };
}
