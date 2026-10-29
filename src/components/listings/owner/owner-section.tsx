"use client";

import { useState } from "react";
import { LayoutGrid } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useApiErrorMessage } from "@/components/auth/form-message";
import { Select } from "@/components/post/controls/select";
import type { ShopSection } from "@/lib/contracts/catalog";
import type { OwnerListingSummary } from "@/lib/contracts/listings";
import { isolate } from "@/lib/i18n/bidi";
import { saveSection } from "@/lib/listings/client/api";

// "Mes annonces" row of a Pro listing (catalogue §5): its section of the storefront, saved on
// change (a classification: no new moderation). Shown once the shop has sections.

export function OwnerSection({ listing, title, sections, onChanged }: { listing: OwnerListingSummary; title: string; sections: ShopSection[]; onChanged: (listing: OwnerListingSummary) => void }) {
  const t = useTranslations("MyListings.section");
  const apiMessage = useApiErrorMessage();
  const [saving, setSaving] = useState(false);
  // A removed section reads as none.
  const value = sections.some((section) => section.id === listing.sectionId) ? (listing.sectionId ?? "") : "";

  async function change(next: string) {
    setSaving(true);
    try {
      const response = await saveSection(listing.id, { sectionId: next || null });
      toast.success(t("saved"));
      onChanged(response.listing);
    } catch (error) {
      toast.error(apiMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <label className="mt-1 flex max-w-xs items-center gap-2 text-xs text-foreground-muted">
      <LayoutGrid className="size-4 shrink-0" aria-hidden="true" />
      <span className="sr-only">{t("labelOf", { title: isolate(title) })}</span>
      <Select data-testid="owner-section" value={value} disabled={saving} onChange={(event) => void change(event.target.value)} className="h-9 py-1 text-sm max-sm:h-11">
        <option value="">{t("none")}</option>
        {sections.map((section) => (
          <option key={section.id} value={section.id}>
            {section.name}
          </option>
        ))}
      </Select>
    </label>
  );
}
