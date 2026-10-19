import { apiRoute } from "@/lib/http/route";
import { handleAssistant } from "@/lib/help/handlers";

// POST /api/assistant: the Assistant Joutiya (design phase-5 D25); logic in src/lib/help.
export const dynamic = "force-dynamic";
export const POST = apiRoute(handleAssistant);
