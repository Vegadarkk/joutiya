import { handleAuthorityCreate, handleAuthorityList } from "@/lib/decisions/handlers";
import { apiRoute } from "@/lib/http/route";

// Authority requests register, admin only (design D17): list (GET) and record (POST).
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleAuthorityList);
export const POST = apiRoute(handleAuthorityCreate);
