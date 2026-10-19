import { serverEnv } from "@/lib/env";
import { notFound } from "@/lib/http/errors";
import { apiRoute, json } from "@/lib/http/route";
import { rebuildFromFirestore } from "@/lib/search/indexer";

// Development only (APP_ENV=dev): indexes every published listing from Firestore into the live
// search index and drops every other document (e2e: seed, then POST here). Anywhere else the route
// does not exist; deployed environments rebuild with scripts/reindex-search.ts.
export const dynamic = "force-dynamic";

export const POST = apiRoute(async () => {
  if (serverEnv().APP_ENV !== "dev") throw notFound();
  return json(await rebuildFromFirestore());
});
