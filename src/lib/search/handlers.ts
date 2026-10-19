import "server-only";
import { applyDevice, deviceOf, jsonResponse, type Device } from "@/lib/auth/respond";
import type { SearchApiResponse } from "@/lib/contracts/search";
import { HttpError } from "@/lib/http/errors";
import { challengePassCookie } from "@/lib/security/challenge-pass";
import { enforceSearchLimit } from "./limits";
import { parseSearchParams, type SearchParams } from "./params";
import { runSearch } from "./service";
import { SearchUnavailableError } from "./types";

// GET /api/search (design D2, D13): lenient URL parse (unknown values dropped, never a 400), the
// search limits before any engine call, then the service. The body carries the canonical
// parameters actually applied. Never cached (apiRoute and jsonResponse set no-store).

/** Engine down or not configured: 503 `search_unavailable`, the page offers a retry. */
export async function searchOrUnavailable(params: SearchParams): Promise<SearchApiResponse> {
  try {
    return await runSearch(params);
  } catch (error) {
    if (error instanceof SearchUnavailableError) throw new HttpError(503, "search_unavailable", undefined, { headers: { "Retry-After": "30" } });
    throw error;
  }
}

/** Device id the pass is bound to: the request's `__Host-did`, else the fresh one this response sets. */
function deviceIdOf(device: Device): string | null {
  return device.identity.deviceId ?? device.fresh?.id ?? null;
}

export async function handleSearch(request: Request): Promise<Response> {
  const params = parseSearchParams(new URL(request.url).searchParams);
  const device = deviceOf(request);
  const { passGranted } = await enforceSearchLimit(request);
  const body = await searchOrUnavailable(params);
  const response = applyDevice(jsonResponse(body), device);
  const deviceId = deviceIdOf(device);
  // Appended after the cookie API wrote __Host-did: NextResponse rewrites only the cookies it set.
  if (passGranted && deviceId) response.headers.append("Set-Cookie", await challengePassCookie(deviceId));
  return response;
}
