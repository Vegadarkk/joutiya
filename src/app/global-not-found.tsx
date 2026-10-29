import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { DoorMark } from "@/components/feedback/door-mark";
import { buttonVariants } from "@/components/ui/button";
import { readex } from "@/lib/fonts";
import "@/styles/globals.css";

// URLs no route matches (localized paths have their own 404 inside the site chrome).

export const metadata: Metadata = { title: "Page introuvable · Aalan", robots: { index: false, follow: false } };

export default async function GlobalNotFound() {
  const t = await getTranslations({ locale: "fr", namespace: "NotFound" });
  return (
    <html lang="fr-MA" dir="ltr" className={readex.variable}>
      <body className="flex min-h-dvh items-center justify-center bg-background antialiased">
        <main className="flex max-w-md flex-col items-center gap-4 px-4 py-14 text-center">
          <DoorMark className="w-20" />
          <h1 className="text-xl font-semibold text-balance">{t("title")}</h1>
          <p className="text-foreground-muted text-pretty">{t("body")}</p>
          <Link href="/fr" className={buttonVariants({ className: "mt-2" })}>
            {t("back")}
          </Link>
        </main>
      </body>
    </html>
  );
}
