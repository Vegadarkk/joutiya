import Link from "next/link";
import { Button } from "@/components/ui/button";

/** Unknown page, or a page another role cannot see (moderators on /personnel). */
export default function AdminNotFound() {
  return (
    <section className="flex flex-col items-start gap-3 py-8">
      <h1 className="text-2xl font-semibold">Page introuvable</h1>
      <p className="text-foreground-muted">Cette page n&apos;existe pas, ou votre rôle n&apos;y donne pas accès.</p>
      <Button asChild variant="outline">
        <Link href="/">Retour aux quotas</Link>
      </Button>
    </section>
  );
}
