import "server-only";
import { requireUser } from "@/lib/auth/guards";
import { buyOptionSchema, LEDGER_PAGE_SIZE, type LedgerEntryView, type WalletResponse } from "@/lib/contracts/payments";
import { OPTION_IDS, type OptionId } from "@/config/pricing";
import { getWallet, listLedger, type LedgerRecord } from "@/lib/db/repositories/wallets";
import { getFlags } from "@/lib/config/runtime";
import { HttpError, notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { json } from "@/lib/http/route";
import { isListingId } from "@/lib/listings/ids";
import { assertQuotas, DEPOSIT_QUOTAS } from "@/lib/quota/gate";
import { consumeLimit, enforceLimit } from "@/lib/rate-limit/limiter";
import { buyOption, listingOptions, memberBillingAccount, walletSummary } from "./options";

// Route handlers of the credits wallet and the paid options (phase 7 design §5, §9): requireUser
// (Origin + CSRF on the purchase), the per-account limiter before the first Firestore read, the
// owner check inside the service (404 for someone else's listing). Reads are charged in documents
// (`wallet.read.uid`), the purchase per attempt (`listing.options.uid`, closed: it debits credits).

type Params = Promise<Record<string, string | string[] | undefined>>;

async function listingIdOf(params: Params): Promise<string> {
  const { id } = await params;
  if (typeof id !== "string" || !isListingId(id)) throw notFound();
  return id;
}

/** GET /api/listings/{id}/options: reads the listing and the wallet. */
export async function handleListingOptions(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request);
  const id = await listingIdOf(params);
  await enforceLimit("wallet.read.uid", auth.user.uid);
  const body = await listingOptions(auth, id);
  await consumeLimit("wallet.read.uid", auth.user.uid, 1);
  return json(body);
}

/** POST /api/listings/{id}/options. */
export async function handleBuyOption(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const id = await listingIdOf(params);
  const input = await readJson(request, buyOptionSchema);
  // The listing and the ledger entry are read first (a retry is answered from it); a new purchase
  // then passes the closed per-attempt limit and the write quota.
  await enforceLimit("wallet.read.uid", auth.user.uid, 2);
  const beforePurchase = async () => {
    await enforceLimit("listing.options.uid", auth.user.uid);
    await assertQuotas(DEPOSIT_QUOTAS);
  };
  return json(await buyOption(auth, id, input, { beforePurchase }));
}

/** Ledger entry ids are deterministic (`option_{listingId}_{uuid}`, `purchase_{...}`). */
const ENTRY_ID = /^[A-Za-z0-9_-]{1,200}$/;

function entryView(entry: LedgerRecord): LedgerEntryView {
  const optionId = (OPTION_IDS as readonly string[]).includes(entry.refs.optionId ?? "") ? (entry.refs.optionId as OptionId) : null;
  return {
    id: entry.id,
    reason: entry.reason,
    delta: entry.delta,
    planCreditsDelta: entry.planCreditsDelta,
    featuredAllowanceDelta: entry.featuredAllowanceDelta,
    balanceAfter: entry.balanceAfter,
    optionId,
    listingId: entry.refs.listingId ?? null,
    at: entry.at.toISOString(),
  };
}

/** GET /api/wallet[?after=entryId]: the member's (or their shop's) wallet and a ledger page. A suspended account still reads it. */
export async function handleWallet(request: Request): Promise<Response> {
  const auth = await requireUser(request, { allowSuspended: true });
  const after = new URL(request.url).searchParams.get("after") ?? undefined;
  if (after !== undefined && !ENTRY_ID.test(after)) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "after", code: "invalid_value" }] });
  await enforceLimit("wallet.read.uid", auth.user.uid);
  const { accountId, kind } = memberBillingAccount(auth);
  const [flags, wallet, page] = await Promise.all([getFlags(), getWallet(accountId), listLedger(accountId, LEDGER_PAGE_SIZE, after)]);
  await consumeLimit("wallet.read.uid", auth.user.uid, page.entries.length + (after ? 1 : 0));
  const now = new Date();
  const body: WalletResponse = { salesOpen: flags.salesEnabled, account: kind, wallet: walletSummary(wallet, now), entries: page.entries.map(entryView), next: page.next ?? null };
  return json(body);
}
