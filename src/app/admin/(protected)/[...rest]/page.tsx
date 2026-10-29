import { notFound } from "next/navigation";

// Any admin path no page claims: the back office's own "Page introuvable" (not-found.tsx, inside
// the shell) instead of the framework's bare 404, which the admin host rewrite otherwise reaches
// (UX audit, finding 21).
export default function AdminCatchAll(): never {
  notFound();
}
