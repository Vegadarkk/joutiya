"use client";

import { Store } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { useSession } from "@/lib/auth/client";
import { PRO_LANDING_PATH, PRO_SPACE_PATH } from "@/lib/search/shortcuts";
import { cn } from "@/lib/utils";
import { HEADER_PILL_CLASS } from "./rent-entry";

// "Espace Pro" beside "Vendre" (owner's choice B, 29 Oct 2026), in a gold ring like the threshold
// of the arch: the public page of the Pro offer for visitors and members, the Pro space itself for
// a Pro (the session is the one the account menu already holds; public pages start anonymous and
// swap once /api/auth/me has answered). Shown from lg, "Pro" alone until xl.

export function ProEntry() {
  const t = useTranslations("Nav");
  const { status, session } = useSession();
  const href = status === "ready" && session?.role === "pro" ? PRO_SPACE_PATH : PRO_LANDING_PATH;
  return (
    <Link
      href={href}
      prefetch={false}
      data-testid="header-pro"
      className={cn(HEADER_PILL_CLASS, "text-structure shadow-[0_0_0_1.5px_var(--featured),0_8px_20px_-10px_var(--float-shadow)] dark:text-gold-300")}
    >
      <Store className="size-5" aria-hidden="true" />
      <span className="hidden xl:inline">{t("proSpace")}</span>
      <span className="xl:hidden">{t("proShort")}</span>
    </Link>
  );
}
