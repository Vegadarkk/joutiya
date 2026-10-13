"use client";

import { ErrorView } from "@/components/feedback/error-view";

export default function SegmentError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorView retry={retry} />;
}
