import { describe, expect, it } from "vitest";
import { CLAIMS_VERSION, mergeClaims } from "@/lib/firebase/claims";

describe("mergeClaims", () => {
  it("keeps the claims the patch does not name", () => {
    expect(mergeClaims({ role: "individual", st: "suspended", v: 2 }, { role: "pro", proId: "abcdefgh", proRole: "owner" })).toEqual({
      role: "pro",
      proId: "abcdefgh",
      proRole: "owner",
      st: "suspended",
      v: CLAIMS_VERSION,
    });
  });

  it("removes a claim set to null", () => {
    expect(mergeClaims({ role: "pro", proId: "abcdefgh", proRole: "owner", st: "suspended" }, { st: null })).toEqual({
      role: "pro",
      proId: "abcdefgh",
      proRole: "owner",
      v: CLAIMS_VERSION,
    });
  });

  it("stamps the claims version", () => {
    expect(mergeClaims({}, { role: "individual" })).toEqual({ role: "individual", v: CLAIMS_VERSION });
  });

  it("rejects an invalid value", () => {
    expect(() => mergeClaims({}, { proId: "" })).toThrow();
  });
});
