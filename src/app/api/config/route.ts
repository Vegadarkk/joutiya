import { publicConfig } from "@/lib/config/public";
import { getFlags } from "@/lib/config/runtime";

// Browser configuration (§2): static public pages are built once for staging and production,
// so they fetch it here instead of carrying it in their HTML. Public values only.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(publicConfig(undefined, await getFlags()), { headers: { "Cache-Control": "public, max-age=300" } });
}
