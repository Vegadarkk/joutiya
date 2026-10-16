import { handleAppealLinkView, handleLinkAppeal } from "@/lib/decisions/handlers";
import { apiRoute } from "@/lib/http/route";

// Appeals through the signed link of a decision or outcome mail (design D16): banned accounts and
// notifiers without an account. GET shows the decision, POST opens the appeal.
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleAppealLinkView);
export const POST = apiRoute(handleLinkAppeal);
