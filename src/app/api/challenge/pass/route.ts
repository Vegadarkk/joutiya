import { apiRoute } from "@/lib/http/route";
import { handleChallengePass } from "@/lib/security/challenge-handler";

// POST /api/challenge/pass (design D14): Turnstile "pages" token -> __Host-tsv pass, 204.
export const dynamic = "force-dynamic";
export const POST = apiRoute(handleChallengePass);
