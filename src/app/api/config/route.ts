import { publicConfig } from "@/lib/config/public";

// Browser configuration (§2): static public pages are built once for staging and production,
// so they fetch it here instead of carrying it in their HTML. Public values only.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(publicConfig(), { headers: { "Cache-Control": "public, max-age=300" } });
}
