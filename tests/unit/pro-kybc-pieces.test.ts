import { describe, expect, it } from "vitest";
import { kybcObjectKey, sniffKybcType } from "@/lib/pro/kybc";
import { KYBC_RECHECK_MS, KYBC_REJECTED_RETENTION_MS, kybcRetention } from "@/lib/pro/kybc-retention";

// KYBC pieces (phase 7 design §4): real type from the first bytes, private key, retention with
// the application.

const bytes = (...values: number[]) => new Uint8Array(values);

describe("sniffKybcType", () => {
  it("recognises JPEG, PNG and PDF", () => {
    expect(sniffKybcType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffKybcType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe("image/png");
    expect(sniffKybcType(new TextEncoder().encode("%PDF-1.7\n"))).toBe("application/pdf");
  });

  it("refuses anything else, a PDF header after offset 0 included", () => {
    expect(sniffKybcType(new TextEncoder().encode(" %PDF-1.7"))).toBeNull();
    expect(sniffKybcType(new TextEncoder().encode("<html>"))).toBeNull();
    expect(sniffKybcType(new TextEncoder().encode("RIFF....WEBP"))).toBeNull();
    expect(sniffKybcType(bytes(0xff, 0xd8))).toBeNull();
  });
});

describe("kybcObjectKey", () => {
  it("files pieces by owner", () => {
    expect(kybcObjectKey("uid-1", "abcdEFGH1234")).toBe("kyb/uid-1/abcdEFGH1234");
  });
});

describe("kybcRetention", () => {
  const now = new Date("2026-10-16T10:00:00.000Z");
  const profile = (lifecycle: "pending_verification" | "verified" | "rejected", updatedAt = now, uploadIds = ["up1"]) => ({
    lifecycle,
    updatedAt,
    kybc: { status: "submitted" as const, iceFormatOk: true, uploadIds },
  });

  it("keeps a piece the application lists, rechecked in 30 days", () => {
    expect(kybcRetention("up1", profile("pending_verification"), now)).toEqual({ keep: true, until: new Date(now.getTime() + KYBC_RECHECK_MS) });
    expect(kybcRetention("up1", profile("verified"), now)).toEqual({ keep: true, until: new Date(now.getTime() + KYBC_RECHECK_MS) });
  });

  it("deletes a piece no application lists", () => {
    expect(kybcRetention("up2", profile("verified"), now)).toEqual({ keep: false });
    expect(kybcRetention("up1", null, now)).toEqual({ keep: false });
  });

  it("keeps a rejected application's pieces 6 months after the rejection", () => {
    const rejectedAt = new Date(now.getTime() - KYBC_REJECTED_RETENTION_MS + 5 * 24 * 60 * 60 * 1000);
    expect(kybcRetention("up1", profile("rejected", rejectedAt), now)).toEqual({ keep: true, until: new Date(rejectedAt.getTime() + KYBC_REJECTED_RETENTION_MS) });
    expect(kybcRetention("up1", profile("rejected", new Date(now.getTime() - KYBC_REJECTED_RETENTION_MS)), now)).toEqual({ keep: false });
  });
});
