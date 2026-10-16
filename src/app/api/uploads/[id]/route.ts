import { handleDelete, handleStatus } from "@/lib/uploads/handlers";
import { apiRoute } from "@/lib/http/route";

// /api/uploads/{id}: GET (owner's processing status, polled by the wizard), DELETE (204).
export const dynamic = "force-dynamic";
export const GET = apiRoute((request, context) => handleStatus(request, context.params));
export const DELETE = apiRoute((request, context) => handleDelete(request, context.params));
