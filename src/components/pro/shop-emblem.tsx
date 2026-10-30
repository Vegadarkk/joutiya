import { Building2, Car, Store, TreePalm, type LucideIcon } from "lucide-react";
import type { ProSector } from "@/lib/pro/profile-schema";
import { cn } from "@/lib/utils";

// The shop's emblem until it uploads a logo (owner, 2026-10-30: a shop needs an image): its
// initials in a door arch, coloured from its name in the brand's palette, with the icon of its
// trade; and a zellige band in the same colour for the top of its card. Pure SVG and CSS, the
// same on the server and in both themes (white on a saturated ground).

const PALETTE = ["#1f5b45", "#b5652b", "#8a6a1c", "#2f4f7a", "#7a2f3a", "#3f6b2a"] as const;

const SECTOR_ICONS: Record<ProSector, LucideIcon> = {
  general: Store,
  real_estate: Building2,
  car_rental: Car,
  holiday_rental: TreePalm,
};

/** A stable colour from the shop's name. */
export function shopHue(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return PALETTE[hash % PALETTE.length] ?? PALETTE[0];
}

/** One or two letters: the first of the first two words. */
export function shopInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => /\p{L}|\p{N}/u.test(word));
  const letters = words.slice(0, 2).map((word) => Array.from(word.replace(/^[^\p{L}\p{N}]+/u, ""))[0] ?? "");
  return letters.join("").toLocaleUpperCase() || "?";
}

export function ShopEmblem({ name, sector, size = "md", className }: { name: string; sector: ProSector; size?: "md" | "lg"; className?: string }) {
  const Icon = SECTOR_ICONS[sector];
  const large = size === "lg";
  return (
    <span aria-hidden="true" className={cn("relative inline-flex shrink-0", large ? "size-20" : "size-14", className)}>
      <svg viewBox="0 0 56 56" className="size-full drop-shadow-sm">
        <path d="M4 54V24C4 11 15 2 28 2s24 9 24 22v30z" fill={shopHue(name)} stroke="#f4ead6" strokeWidth="2.5" />
        <path d="M10 54V25c0-10 8-17 18-17s18 7 18 17v29" fill="none" stroke="#d9b45a" strokeWidth="1.5" opacity="0.8" />
        <text x="28" y="38" textAnchor="middle" fontSize={shopInitials(name).length > 1 ? 17 : 21} fontWeight="700" fill="#fffaf0" fontFamily="inherit">
          {shopInitials(name)}
        </text>
      </svg>
      <span className={cn("absolute -end-1 -bottom-1 flex items-center justify-center rounded-full bg-featured text-featured-foreground ring-2 ring-surface", large ? "size-8" : "size-6")}>
        <Icon className={large ? "size-4.5" : "size-3.5"} />
      </span>
    </span>
  );
}

/** The zellige band at the top of a shop's card, in the shop's colour. */
export function ShopBand({ name, className }: { name: string; className?: string }) {
  const hue = shopHue(name);
  return (
    <span
      aria-hidden="true"
      className={cn("block h-16 w-full", className)}
      style={{
        backgroundColor: hue,
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E%3Cg fill='none' stroke='%23f4ead6' stroke-opacity='0.28' stroke-width='1.2'%3E%3Cpath d='M16 2l4 10 10 4-10 4-4 10-4-10-10-4 10-4z'/%3E%3Ccircle cx='16' cy='16' r='3'/%3E%3C/g%3E%3C/svg%3E\")",
      }}
    />
  );
}
