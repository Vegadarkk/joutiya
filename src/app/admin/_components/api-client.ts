import type { ErrorBody } from "@/lib/http/errors";

// Browser side of the back-office API (client islands only). Mutations carry the signed CSRF
// token read from the __Host-csrf cookie (src/lib/security/cookies.ts); the Origin header comes
// from the browser. Error codes are translated here, in French, for the staff.

export const ADMIN_API = {
  login: "/api/admin/auth/login",
  logout: "/api/admin/auth/logout",
  password: "/api/admin/auth/password",
  staff: "/api/admin/staff",
  decisions: "/api/admin/decisions",
  appeals: "/api/admin/appeals",
  authorities: "/api/admin/authorities",
  conversations: "/api/admin/conversations",
  exports: "/api/admin/exports",
  users: "/api/admin/users",
  legal: "/api/admin/legal",
  guideLinks: "/api/admin/guide/links",
} as const;

const CSRF_COOKIE = "__Host-csrf";

export function readCsrfCookie(): string {
  const prefix = `${CSRF_COOKIE}=`;
  const pair = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  if (!pair) return "";
  try {
    return decodeURIComponent(pair.slice(prefix.length));
  } catch {
    return pair.slice(prefix.length);
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** `details` of the error body (field paths of an invalid body, missing mentions). */
    readonly details?: unknown,
  ) {
    super(`${status} ${code}`);
    this.name = "ApiError";
  }
}

interface FetchOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Authenticated mutation: sends the CSRF header. */
  csrf?: boolean;
}

/** JSON call to the admin API; null for a 204; throws ApiError (code) or TypeError (network). */
export async function adminFetch<T>(path: string, options: FetchOptions): Promise<T | null> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.csrf) headers["x-csrf-token"] = readCsrfCookie();
  const response = await fetch(path, {
    method: options.method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    credentials: "same-origin",
  });
  if (response.status === 204) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload as ErrorBody | null)?.error;
    throw new ApiError(response.status, error?.code ?? "internal", error?.details);
  }
  return payload as T;
}

const COMMON_MESSAGES: Record<string, string> = {
  unauthenticated: "Votre session a expiré. Reconnectez-vous.",
  csrf: "Votre session a expiré. Rechargez la page.",
  origin: "Requête refusée. Rechargez la page.",
  rate_limited: "Trop de tentatives. Réessayez plus tard.",
  forbidden: "Action réservée à un autre rôle.",
  not_found: "Introuvable : rechargez la page.",
  unavailable: "Service indisponible. Réessayez dans un instant.",
  network: "Connexion au serveur impossible. Vérifiez votre réseau.",
  internal: "Une erreur est survenue. Réessayez.",
};

/** French message for a failed call; `specific` wins over the common codes. */
export function errorMessage(error: unknown, specific: Record<string, string> = {}): string {
  const code = error instanceof ApiError ? error.code : "network";
  return specific[code] ?? COMMON_MESSAGES[code] ?? COMMON_MESSAGES["internal"]!;
}
