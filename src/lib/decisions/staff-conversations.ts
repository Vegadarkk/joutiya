import "server-only";
import { audit } from "@/lib/audit";
import { cidSchema } from "@/lib/contracts/messaging";
import { forbidden, notFound } from "@/lib/http/errors";
import { getConversationForStaff } from "@/lib/messaging";
import { consume } from "@/lib/quota";
import { splitMessageId } from "@/lib/reports/target-key";
import { openAuthorityIds } from "./authorities";
import type { StaffConversationView } from "./contracts";
import { conversationRef, reportsOnConversation } from "./repository";

// Staff access to a conversation (design D18): only when a report (open or decided) targets one
// of its messages, or an open authority request holds it; a reason (10-300 characters) is given
// and every opening is audited (`conversation.read`). The 200 newest messages; the original text
// of hidden or masked messages only for the reported ones (all of them under an authority request).

const AUTHORITY_PREFIX = "authority:";

export interface StaffReader {
  uid: string;
  role: "moderator" | "admin";
}

export async function staffConversation(reader: StaffReader, cid: string, reason: string, options: { ip?: string; now?: Date } = {}): Promise<StaffConversationView> {
  const now = options.now ?? new Date();
  if (!cidSchema.safeParse(cid).success) throw notFound();
  const reports = await reportsOnConversation(cid);
  const reportedMids = [...new Set(reports.flatMap((report) => splitMessageId(report.target.id)?.mid ?? []))];
  const snapshot = await conversationRef(cid).get();
  void consume("firestore.reads", 1);
  if (!snapshot.exists) throw notFound();
  const holds: unknown = snapshot.get("legalHold");
  const authorityIds = (Array.isArray(holds) ? holds : [])
    .filter((hold): hold is string => typeof hold === "string" && hold.startsWith(AUTHORITY_PREFIX))
    .map((hold) => hold.slice(AUTHORITY_PREFIX.length));
  const openAuthorities = await openAuthorityIds(authorityIds);
  if (reports.length === 0 && openAuthorities.length === 0) throw forbidden("no report or authority request on this conversation");

  // Under an authority request every original is shown; under reports only the reported messages'.
  const transcript = await getConversationForStaff(cid, undefined, openAuthorities.length > 0 ? {} : { evidenceFor: reportedMids });
  if (!transcript) throw notFound();
  await audit({
    actorUid: reader.uid,
    actorRole: reader.role,
    action: "conversation.read",
    target: { type: "conversation", id: cid },
    automated: false,
    reason: reason.slice(0, 300),
    ...(options.ip ? { ip: options.ip } : {}),
    at: now,
  });

  const { conversation } = transcript;
  const reported = new Set(reportedMids);
  const from = (senderUid: string, type: string): "buyer" | "seller" | "system" => (type === "system" ? "system" : senderUid === conversation.sellerUid ? "seller" : "buyer");
  return {
    cid,
    listingId: conversation.listingId,
    listingTitle: conversation.listingSnapshot.title,
    status: conversation.status,
    buyer: { uid: conversation.buyerUid, name: conversation.buyerName, publicId: conversation.buyerPublicId },
    seller: { uid: conversation.sellerUid, name: conversation.sellerName, publicId: conversation.sellerPublicId },
    messages: transcript.messages.map((message) => ({
      id: message.id,
      from: from(message.senderUid, message.type),
      text: message.text,
      hidden: message.hidden === true,
      flags: [...(message.risk?.flags ?? [])],
      createdAt: message.createdAt.toISOString(),
      reported: reported.has(message.id),
    })),
    evidence: Object.fromEntries(Object.entries(transcript.evidence).map(([mid, evidence]) => [mid, { text: evidence.text, reason: evidence.reason }])),
    access: { reportIds: reports.map((report) => report.id), authorityHolds: openAuthorities.map((id) => `${AUTHORITY_PREFIX}${id}`) },
  };
}
