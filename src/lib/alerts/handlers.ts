import "server-only";
import { unsubscribeSchema } from "@/lib/contracts/search";
import { HttpError } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { noContent } from "@/lib/http/route";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceIpLimit } from "@/lib/rate-limit/limiter";
import { disableAlerts, getSavedSearch } from "@/lib/saved-searches/repository";
import { UNSUBSCRIBE_ALL, verifyUnsubscribeToken, type UnsubscribeTarget } from "./unsubscribe-token";

// POST /api/alerts/unsubscribe (design D20). Two callers: the mailbox provider's RFC 8058
// one-click POST to the List-Unsubscribe URL (`?t=<token>`, form body "List-Unsubscribe=One-Click"
// ignored), and the confirm button of /alertes/desabonnement (JSON `{ token }`). No session, no
// Origin or CSRF check, like the webhooks: the signed token is the authentication and it can only
// turn alerts off. Limited per IP. GET is not exported (405): a link prefetch never unsubscribes.

const invalidToken = () => new HttpError(400, "invalid_token");

async function tokenOf(request: Request): Promise<string> {
  const query = new URL(request.url).searchParams.get("t");
  if (query !== null) {
    const parsed = unsubscribeSchema.shape.token.safeParse(query);
    if (!parsed.success) throw invalidToken();
    return parsed.data;
  }
  return (await readJson(request, unsubscribeSchema)).token;
}

export async function handleUnsubscribe(request: Request): Promise<Response> {
  await enforceIpLimit("alerts.unsubscribe.ip", requestIdentity(request.headers));
  const target = verifyUnsubscribeToken(await tokenOf(request));
  if (!target) throw invalidToken();
  // A deleted search or an alert already off: nothing to do, same answer (idempotent).
  await disableAlerts(target.uid, target.searchId);
  return noContent();
}

/** What the confirm page shows for a link (reads only; GET never changes anything). */
export type UnsubscribeDescription = { kind: "invalid" } | { kind: "all" } | { kind: "one"; name: string; active: boolean } | { kind: "gone" };

export async function describeUnsubscribe(token: string | undefined): Promise<UnsubscribeDescription> {
  const target: UnsubscribeTarget | null = token && unsubscribeSchema.shape.token.safeParse(token).success ? verifyUnsubscribeToken(token) : null;
  if (!target) return { kind: "invalid" };
  if (target.searchId === UNSUBSCRIBE_ALL) return { kind: "all" };
  const search = await getSavedSearch(target.uid, target.searchId);
  return search ? { kind: "one", name: search.name, active: search.alert === "daily" } : { kind: "gone" };
}
