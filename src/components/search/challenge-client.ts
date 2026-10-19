import { SEARCH_API, TURNSTILE_HEADER } from "@/lib/contracts/search";
import { searchParamsToQuery, type SearchParams } from "@/lib/search/params";

// Search challenge (design D13): the server-rendered page cannot set cookies, so the solved
// Turnstile token goes to GET /api/search with the same parameters; that answer sets the
// `__Host-tsv` pass (and `__Host-did` when missing), then the page renders again and passes.

export type ChallengeOutcome =
  /** Pass set: render the page again. */
  | { kind: "passed" }
  /** Token refused (expired, reused, wrong action): solve again. */
  | { kind: "failed" }
  /** Over the limits even with a pass, or too many failed tokens. */
  | { kind: "limited"; retryAfter?: number }
  /** Network failure or search unavailable: try again later. */
  | { kind: "error" };

export function challengeUrl(params: SearchParams): string {
  const query = searchParamsToQuery(params).toString();
  return query ? `${SEARCH_API.search}?${query}` : SEARCH_API.search;
}

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    return typeof body?.error?.code === "string" ? body.error.code : undefined;
  } catch {
    return undefined;
  }
}

export async function submitSearchChallenge(params: SearchParams, token: string, fetcher: typeof fetch = fetch): Promise<ChallengeOutcome> {
  let response: Response;
  try {
    response = await fetcher(challengeUrl(params), {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json", [TURNSTILE_HEADER]: token },
    });
  } catch {
    return { kind: "error" };
  }
  if (response.ok) return { kind: "passed" };
  if (response.status === 429) {
    const seconds = Number(response.headers.get("Retry-After"));
    return { kind: "limited", retryAfter: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined };
  }
  const code = await errorCode(response);
  if (response.status === 403 && (code === "turnstile_failed" || code === "turnstile_required")) return { kind: "failed" };
  return { kind: "error" };
}
