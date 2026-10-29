"use client";

import "@/styles/globals.css";

// Last-resort boundary (an error in a root layout): its own document, no providers, French and
// Arabic since the locale may be unknown.
export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="fr-MA" dir="ltr">
      <body className="flex min-h-dvh items-center justify-center bg-background font-sans antialiased">
        <title>Aalan</title>
        <main className="flex max-w-md flex-col items-center gap-3 px-4 py-14 text-center">
          <h1 className="text-xl font-semibold">La page n&apos;a pas pu s&apos;afficher</h1>
          <p lang="ar" dir="rtl" className="text-lg">
            تعذّر عرض الصفحة
          </p>
          <p className="text-foreground-muted">Un incident technique a interrompu le chargement. Réessayez dans quelques instants.</p>
          <button
            type="button"
            onClick={() => retry()}
            className="mt-2 inline-flex h-11 items-center rounded-md bg-primary px-5 font-medium text-primary-foreground hover:bg-primary-hover"
          >
            Réessayer · إعادة المحاولة
          </button>
        </main>
      </body>
    </html>
  );
}
