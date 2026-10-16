"use client";

import { useMemo } from "react";
import { useSession } from "@/lib/auth/client";
import { useWizard } from "@/lib/listings/client/store";
import type { IssueOptions } from "@/lib/listings/client/validation";

/** Validation context of the wizard: the photo cap and, once /me answered, the phone badge (no blocker on a guess). */
export function useIssueOptions(): IssueOptions & { maxPhotos: number } {
  const { maxPhotos } = useWizard();
  const { status, session } = useSession();
  const phoneVerified = status === "ready" ? Boolean(session?.phoneVerified) : undefined;
  return useMemo(() => ({ maxPhotos, phoneVerified }), [maxPhotos, phoneVerified]);
}
