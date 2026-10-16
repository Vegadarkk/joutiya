// schema.org structured data of the landing pages (design D15). Pure. BreadcrumbList only: Google
// shows no rich result for an ItemList of listings. Serialized by `JsonLd` (serializeJsonLd escapes
// it for the inline data block).

export interface BreadcrumbStep {
  name: string;
  /** Absolute URL; Google allows the last step (the current page) without one. */
  url?: string;
}

/** BreadcrumbList with 1-based positions; null with fewer than two steps (Google needs two). */
export function breadcrumbJsonLd(steps: readonly BreadcrumbStep[]): Record<string, unknown> | null {
  if (steps.length < 2) return null;
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: steps.map((step, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: step.name,
      ...(step.url ? { item: step.url } : {}),
    })),
  };
}
