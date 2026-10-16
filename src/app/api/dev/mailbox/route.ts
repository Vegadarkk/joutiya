import { serverEnv } from "@/lib/env";
import { notFound } from "@/lib/http/errors";
import { apiRoute, json, noContent } from "@/lib/http/route";
import { memoryMailbox } from "@/lib/mail/transports/memory";

// Development only (APP_ENV=dev and DEV_MAILBOX=true): the in-memory mailbox the e2e tests and the
// local sign-up flows read. Anywhere else the route does not exist.
export const dynamic = "force-dynamic";

function requireDevMailbox(): void {
  const env = serverEnv();
  if (!(env.APP_ENV === "dev" && env.DEV_MAILBOX)) throw notFound();
}

export const GET = apiRoute(async (request) => {
  requireDevMailbox();
  const params = new URL(request.url).searchParams;
  const to = params.get("to") ?? undefined;
  const template = params.get("template") ?? undefined;
  return json({ mails: memoryMailbox().list({ to, template }) });
});

export const DELETE = apiRoute(async () => {
  requireDevMailbox();
  memoryMailbox().clear();
  return noContent();
});
