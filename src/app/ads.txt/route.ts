import { serverEnv } from "@/lib/env";

// ads.txt (phase 6, D9): declares Google as the only authorised seller of the site's ad space,
// once a publisher id is configured; 404 before (no AdSense, nothing to declare).
export const dynamic = "force-dynamic";

/** Google's certification authority id, fixed for every AdSense publisher. */
const GOOGLE_TAG_ID = "f08c47fec0942fa0";

export function GET(): Response {
  const client = serverEnv().ADSENSE_CLIENT_ID;
  if (!client) return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const publisher = client.replace(/^ca-/, "");
  return new Response(`google.com, ${publisher}, DIRECT, ${GOOGLE_TAG_ID}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
