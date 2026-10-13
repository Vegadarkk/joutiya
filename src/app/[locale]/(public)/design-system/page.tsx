import type { ReactNode } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { Container } from "@/components/layout/container";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { ListingGridSkeleton } from "@/components/feedback/skeletons";
import { FieldDemo, ToastDemo } from "@/components/design/interactive-demos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { pageLocale } from "@/i18n/params";

// Living reference of the design system (tokens and base components), outside production only.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Système de design", robots: { index: false, follow: false } };

const SWATCHES = [
  ["background", "bg-background"],
  ["surface-muted", "bg-surface-muted"],
  ["surface-brand", "bg-surface-brand"],
  ["structure", "bg-structure"],
  ["primary", "bg-primary"],
  ["featured", "bg-featured"],
  ["danger", "bg-danger"],
  ["success", "bg-success"],
  ["warning", "bg-warning"],
] as const;

const TYPE_SCALE = ["text-4xl", "text-3xl", "text-2xl", "text-xl", "text-lg", "text-base", "text-sm", "text-xs"] as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5 border-t border-border pt-8">
      <h2 className="text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export default async function DesignSystemPage({ params }: { params: Promise<{ locale: string }> }) {
  if (process.env.APP_ENV === "prod") notFound();
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  return (
    <Container className="flex flex-col gap-10 py-10">
      <h1 className="text-3xl font-semibold">Système de design</h1>

      <Section title="Couleurs">
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {SWATCHES.map(([name, className]) => (
            <li key={name} className="flex flex-col gap-2">
              <span className={`h-16 rounded-md border border-border ${className}`} />
              <code className="text-xs text-foreground-muted">{name}</code>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Typographie">
        <div className="flex flex-col gap-3">
          {TYPE_SCALE.map((size) => (
            <p key={size} className={`${size} font-medium`}>
              <span className="me-3 inline-block w-20 text-xs font-normal text-foreground-muted">{size}</span>
              Vélo de ville, très bon état
            </p>
          ))}
        </div>
        <p lang="ar" dir="rtl" className="text-2xl font-medium">
          دراجة مدينة في حالة جيدة جداً
        </p>
        <p lang="rif" className="text-2xl font-medium">
          <span className="me-3 inline-block text-xs font-normal text-foreground-muted">Glyphes rifains</span>ɛ ɣ ḥ ṛ ẓ ţ Ɛ Ɣ Ḥ Ṛ Ẓ
        </p>
      </Section>

      <Section title="Boutons">
        <div className="flex flex-wrap items-center gap-3">
          <Button>Déposer une annonce</Button>
          <Button variant="structure">Voir les annonces</Button>
          <Button variant="outline">Annuler</Button>
          <Button variant="ghost">Plus tard</Button>
          <Button variant="link">Conditions</Button>
          <Button variant="danger">Supprimer l&apos;annonce</Button>
          <Button loading>Publication</Button>
          <Button disabled>Indisponible</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">Petit</Button>
          <Button size="md">Moyen</Button>
          <Button size="lg">Grand</Button>
        </div>
      </Section>

      <Section title="Champs et validation">
        <FieldDemo />
      </Section>

      <Section title="Badges">
        <div className="flex flex-wrap gap-2">
          <Badge variant="featured">À la Une · Sponsorisé</Badge>
          <Badge>Remontée</Badge>
          <Badge variant="pro">Pro</Badge>
          <Badge variant="success">Téléphone vérifié</Badge>
          <Badge variant="warning">En attente de modération</Badge>
          <Badge variant="danger">Refusée</Badge>
        </div>
      </Section>

      <Section title="Messages">
        <ErrorBanner title="L'annonce n'a pas pu être publiée">Une photo dépasse 10 Mo. Remplacez-la puis publiez à nouveau.</ErrorBanner>
        <ErrorBanner tone="warning" title="Votre annonce expire dans 3 jours">Renouvelez-la pour la garder en ligne.</ErrorBanner>
        <ErrorBanner tone="info" title="Joutiya ouvre bientôt">Les annonces apparaîtront ici dès l&apos;ouverture du dépôt.</ErrorBanner>
      </Section>

      <Section title="Notifications">
        <ToastDemo />
      </Section>

      <Section title="Chargement">
        <ListingGridSkeleton count={4} />
      </Section>

      <Section title="État vide">
        <EmptyState title="Aucune annonce en favori" action={<Button variant="outline">Parcourir les annonces</Button>}>
          Touchez le cœur d&apos;une annonce pour la retrouver ici.
        </EmptyState>
      </Section>
    </Container>
  );
}
