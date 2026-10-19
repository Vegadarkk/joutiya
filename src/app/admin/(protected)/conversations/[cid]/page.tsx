import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePageStaff } from "@/lib/auth/current-user";
import { ConversationViewer } from "../../../_components/conversation-viewer";

// Staff reading of a conversation (design D18): only when a report or an open authority request
// targets it, with a reason, journaled (conversation.read). The API decides; this page asks why.

export const metadata: Metadata = { title: "Conversation" };

export default async function ConversationPage({ params }: { params: Promise<{ cid: string }> }) {
  await requirePageStaff(["moderator", "admin"]);
  const { cid } = await params;
  if (!/^[A-Za-z0-9_-]{22}$/.test(cid)) notFound();
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Conversation signalée</h1>
        <p className="mt-1 max-w-prose text-sm text-foreground-muted">
          Les échanges entre membres sont privés : on ne les lit que pour examiner un signalement ou répondre à une autorité, en indiquant pourquoi.
        </p>
      </div>
      <ConversationViewer cid={cid} />
    </>
  );
}
