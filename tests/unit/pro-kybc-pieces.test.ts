import { describe, expect, it } from "vitest";
import { KYBC_NOTICE_VERSION, kybcObjectKey, pdfHasActiveContent, sniffKybcType } from "@/lib/pro/kybc";
import { KYBC_END_RETENTION_MS, KYBC_RECHECK_MS, kybcRetention, relationshipEndedAt, type KybcOwnerView, type KybcProfileView } from "@/lib/pro/kybc-retention";

// KYBC pieces (phase 7 design §4): real type from the first bytes, PDF active-content screen,
// private key, retention with the application and 6 months after the end of the relationship.

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe("sniffKybcType", () => {
  it("recognises JPEG, PNG and PDF", () => {
    expect(sniffKybcType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffKybcType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe("image/png");
    expect(sniffKybcType(text("%PDF-1.7\n"))).toBe("application/pdf");
  });

  it("refuses anything else, a PDF header after offset 0 included", () => {
    expect(sniffKybcType(text(" %PDF-1.7"))).toBeNull();
    expect(sniffKybcType(text("<html>"))).toBeNull();
    expect(sniffKybcType(text("RIFF....WEBP"))).toBeNull();
    expect(sniffKybcType(bytes(0xff, 0xd8))).toBeNull();
  });
});

describe("pdfHasActiveContent", () => {
  const flat = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";

  it("passes a flat document, /Annots and names that merely start alike", () => {
    expect(pdfHasActiveContent(text(flat))).toBe(false);
    expect(pdfHasActiveContent(text("%PDF-1.4 << /Annots [] /AAx 1 /JSON 2 /Launcher 3 /XFAx 4 >>"))).toBe(false);
  });

  it("refuses scripts, launch and open actions, additional actions, embedded files, rich media and XFA forms", () => {
    for (const token of ["/OpenAction 5 0 R", "/S /JavaScript /JS (app.alert(1))", "/S /Launch /F (cmd.exe)", "/AA << /O 5 0 R >>", "/Type /EmbeddedFile", "/EmbeddedFiles 7 0 R", "/Subtype /RichMedia", "/XFA 9 0 R", "/S /GoToR", "/S /SubmitForm", "/S /ImportData"]) {
      expect(pdfHasActiveContent(text(`%PDF-1.7 << ${token} >>`)), token).toBe(true);
    }
  });

  it("decodes #-escaped names before matching", () => {
    expect(pdfHasActiveContent(text("%PDF-1.7 << /S /J#61vaScript >>"))).toBe(true);
    expect(pdfHasActiveContent(text("%PDF-1.7 << /Open#41ction 5 0 R >>"))).toBe(true);
  });
});

describe("kybcObjectKey and the notice", () => {
  it("files pieces by owner", () => {
    expect(kybcObjectKey("uid-1", "abcdEFGH1234")).toBe("kyb/uid-1/abcdEFGH1234");
  });

  it("dates the collection notice", () => {
    expect(KYBC_NOTICE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("kybcRetention", () => {
  const now = new Date("2026-10-16T10:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;
  const profile = (lifecycle: KybcProfileView["lifecycle"], extra: Partial<KybcProfileView> = {}): KybcProfileView => ({
    lifecycle,
    updatedAt: now,
    kybc: { status: "submitted" as const, iceFormatOk: true, uploadIds: ["up1"] },
    ...extra,
  });
  const owner = (status: KybcOwnerView["status"] = "active", extra: Partial<KybcOwnerView> = {}): KybcOwnerView => ({ status, updatedAt: now, ...extra });
  const recheck = new Date(now.getTime() + KYBC_RECHECK_MS);

  it("keeps a piece the application lists while the relationship lasts, rechecked in 30 days", () => {
    for (const lifecycle of ["pending_verification", "verified", "active", "grace", "suspended"] as const) {
      expect(kybcRetention("up1", profile(lifecycle), owner(), now), lifecycle).toEqual({ keep: true, until: recheck });
    }
    expect(kybcRetention("up1", profile("verified"), owner("restricted"), now)).toEqual({ keep: true, until: recheck });
    expect(kybcRetention("up1", profile("verified"), owner("suspended"), now)).toEqual({ keep: true, until: recheck });
  });

  it("deletes a piece no application lists, or without an application or an owner", () => {
    expect(kybcRetention("up2", profile("verified"), owner(), now)).toEqual({ keep: false });
    expect(kybcRetention("up1", null, owner(), now)).toEqual({ keep: false });
    expect(kybcRetention("up1", profile("verified"), null, now)).toEqual({ keep: false });
  });

  it("keeps a rejected application's pieces 6 months after the rejection", () => {
    const rejectedAt = new Date(now.getTime() - KYBC_END_RETENTION_MS + 5 * DAY);
    expect(kybcRetention("up1", profile("rejected", { updatedAt: rejectedAt }), owner(), now)).toEqual({ keep: true, until: new Date(rejectedAt.getTime() + KYBC_END_RETENTION_MS) });
    expect(kybcRetention("up1", profile("rejected", { updatedAt: new Date(now.getTime() - KYBC_END_RETENTION_MS) }), owner(), now)).toEqual({ keep: false });
  });

  it("ends the relationship at the downgrade, the account closure or the ban, whichever came first", () => {
    const downgradedAt = new Date(now.getTime() - 100 * DAY);
    expect(relationshipEndedAt(profile("downgraded", { downgradedAt }), owner())).toEqual(downgradedAt);
    expect(relationshipEndedAt(profile("downgraded"), owner())).toEqual(now);
    const closedAt = new Date(now.getTime() - 10 * DAY);
    expect(relationshipEndedAt(profile("verified"), owner("closed", { closedAt }))).toEqual(closedAt);
    expect(relationshipEndedAt(profile("verified"), owner("banned", { updatedAt: closedAt }))).toEqual(closedAt);
    expect(relationshipEndedAt(profile("downgraded", { downgradedAt }), owner("closed", { closedAt }))).toEqual(downgradedAt);
    expect(relationshipEndedAt(profile("verified"), owner())).toBeNull();
    expect(relationshipEndedAt(profile("suspended"), owner())).toBeNull();
  });

  it("deletes the pieces 6 months after that end, rechecking at most every 30 days until then", () => {
    const closedAt = new Date(now.getTime() - KYBC_END_RETENTION_MS + 10 * DAY);
    expect(kybcRetention("up1", profile("active"), owner("closed", { closedAt }), now)).toEqual({ keep: true, until: new Date(closedAt.getTime() + KYBC_END_RETENTION_MS) });
    expect(kybcRetention("up1", profile("active"), owner("closed", { closedAt: new Date(now.getTime() - KYBC_END_RETENTION_MS) }), now)).toEqual({ keep: false });
    const downgradedAt = new Date(now.getTime() - 10 * DAY);
    expect(kybcRetention("up1", profile("downgraded", { downgradedAt }), owner(), now)).toEqual({ keep: true, until: recheck });
    expect(kybcRetention("up1", profile("downgraded", { downgradedAt: new Date(now.getTime() - KYBC_END_RETENTION_MS - DAY) }), owner("banned"), now)).toEqual({ keep: false });
  });
});
