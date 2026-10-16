import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import type { ListingStatus } from "@/lib/contracts/listings";

const VARIANTS: Record<ListingStatus, "neutral" | "success" | "warning" | "danger" | "featured" | "pro"> = {
  draft: "neutral",
  pending_review: "warning",
  published: "success",
  paused: "neutral",
  sold: "pro",
  expired: "neutral",
  rejected: "danger",
  removed: "danger",
  purged: "danger",
};

/** Status of a listing in the owner's words (Listing.status). */
export function ListingStatusBadge({ status, className }: { status: ListingStatus; className?: string }) {
  const t = useTranslations("Listing.status");
  return (
    <Badge variant={VARIANTS[status]} className={className}>
      {t(status)}
    </Badge>
  );
}
