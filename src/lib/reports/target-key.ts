import { REPORT_TARGET_TYPES, type ReportTargetType } from "@/config/report-reasons";

// Target keys (design D10, D24): `{type}:{id}` names one reported thing across reports, decisions,
// the back-office queue groups and the AI proposals. Stored ids: listing id, account uid (a user
// target), `{cid}/{mid}` (a message), proId (phase 7). Client-safe: the back office builds links.

export interface TargetRef {
  type: ReportTargetType;
  id: string;
}

/** Stored id of each target type (what `reports.target.id` holds). */
const ID_PATTERNS: Record<ReportTargetType, RegExp> = {
  listing: /^[a-hj-km-np-z2-9]{8}$/,
  user: /^[A-Za-z0-9_-]{1,128}$/,
  message: /^[A-Za-z0-9_-]{22}\/[A-Za-z0-9]{20}$/,
  pro: /^[a-z0-9-]{3,64}$/,
};

export function targetKey(target: TargetRef): string {
  return `${target.type}:${target.id}`;
}

export function isStoredTargetId(type: ReportTargetType, id: string): boolean {
  return ID_PATTERNS[type].test(id);
}

/** The target named by a key, or null when the key is malformed (unknown type, id of the wrong shape). */
export function parseTargetKey(key: string): TargetRef | null {
  if (key.length > 160) return null;
  const separator = key.indexOf(":");
  if (separator <= 0) return null;
  const type = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (!(REPORT_TARGET_TYPES as readonly string[]).includes(type)) return null;
  const targetType = type as ReportTargetType;
  return isStoredTargetId(targetType, id) ? { type: targetType, id } : null;
}

/** `{cid}/{mid}` of a message target. */
export function splitMessageId(id: string): { cid: string; mid: string } | null {
  if (!ID_PATTERNS.message.test(id)) return null;
  const [cid = "", mid = ""] = id.split("/");
  return { cid, mid };
}
