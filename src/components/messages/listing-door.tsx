"use client";

import { ImageOff } from "lucide-react";
import { usePublicConfig } from "@/lib/config/client";
import type { ConversationView } from "@/lib/contracts/messaging";
import { blurhashDataUrl } from "@/lib/listings/client/blurhash";
import { photoUrl } from "@/lib/listings/client/photo-url";
import { cn } from "@/lib/utils";

// The listing a conversation is about, as a small doorway: its first photo under the horseshoe
// arch of the Joutiya door (the conversation's subject, where other inboxes put a face).

const SIZES = {
  sm: "h-14 w-12",
  md: "h-12 w-10",
  lg: "h-20 w-16",
} as const;

export function ListingDoor({ conversation, size = "sm", className }: { conversation: Pick<ConversationView, "listingId" | "listing">; size?: keyof typeof SIZES; className?: string }) {
  const config = usePublicConfig();
  const photo = conversation.listing.photo;
  const src = photo ? photoUrl(config?.mediaBaseUrl ?? null, conversation.listingId, photo.id, "s") : null;
  const placeholder = blurhashDataUrl(photo?.blurhash);
  return (
    <span
      aria-hidden="true"
      className={cn("relative block shrink-0 overflow-hidden rounded-t-full rounded-b-md bg-surface-muted ring-1 ring-structure/15 dark:ring-gold-300/20", SIZES[size], className)}
      style={placeholder ? { backgroundImage: `url("${placeholder}")`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover" />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center text-foreground-muted">
          <ImageOff className="size-4" strokeWidth={1.5} />
        </span>
      )}
    </span>
  );
}
