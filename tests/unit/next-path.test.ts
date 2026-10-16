import { describe, expect, it } from "vitest";
import { afterSignInTarget, safeNextPath, splitNextPath } from "@/lib/auth/next-path";

describe("safeNextPath", () => {
  it("accepts a same-origin relative path, with its query and fragment", () => {
    expect(safeNextPath("/fr/parametres")).toBe("/fr/parametres");
    expect(safeNextPath("/fr/recherche?q=vélo&page=2#resultats")).toBe("/fr/recherche?q=vélo&page=2#resultats");
    expect(safeNextPath("/")).toBe("/");
  });

  it("refuses anything that could leave the origin", () => {
    expect(safeNextPath("//evil.example")).toBeNull();
    expect(safeNextPath("//evil.example/fr/parametres")).toBeNull();
    expect(safeNextPath("/\\evil.example")).toBeNull();
    expect(safeNextPath("\\\\evil.example")).toBeNull();
    expect(safeNextPath("https://evil.example/")).toBeNull();
    expect(safeNextPath("javascript:alert(1)")).toBeNull();
    expect(safeNextPath("data:text/html,x")).toBeNull();
    expect(safeNextPath("fr/parametres")).toBeNull();
  });

  it("refuses control characters (header and script injection)", () => {
    expect(safeNextPath("/fr/parametres\r\nSet-Cookie: a=b")).toBeNull();
    expect(safeNextPath("/fr/\u0000")).toBeNull();
    expect(safeNextPath("/fr/\u007f")).toBeNull();
    expect(safeNextPath("/fr/\tparametres")).toBeNull();
  });

  it("refuses empty and missing values", () => {
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
  });
});

describe("splitNextPath", () => {
  it("separates a locale prefix from the path", () => {
    expect(splitNextPath("/fr/parametres")).toEqual({ locale: "fr", pathname: "/parametres" });
    expect(splitNextPath("/ar/verifications?x=1")).toEqual({ locale: "ar", pathname: "/verifications?x=1" });
    expect(splitNextPath("/rif")).toEqual({ locale: "rif", pathname: "/" });
    expect(splitNextPath("/fr?q=1")).toEqual({ locale: "fr", pathname: "/?q=1" });
  });

  it("keeps a path without prefix, and does not mistake a segment for a locale", () => {
    expect(splitNextPath("/parametres")).toEqual({ locale: null, pathname: "/parametres" });
    expect(splitNextPath("/france/x")).toEqual({ locale: null, pathname: "/france/x" });
    expect(splitNextPath("/arabic")).toEqual({ locale: null, pathname: "/arabic" });
  });
});

describe("afterSignInTarget", () => {
  it("follows a safe next and falls back to the settings page", () => {
    expect(afterSignInTarget("/fr/verifications")).toEqual({ locale: "fr", pathname: "/verifications" });
    expect(afterSignInTarget(["/ar/deposer", "/fr"])).toEqual({ locale: "ar", pathname: "/deposer" });
    expect(afterSignInTarget("//evil.example")).toEqual({ locale: null, pathname: "/parametres" });
    expect(afterSignInTarget(undefined)).toEqual({ locale: null, pathname: "/parametres" });
  });
});
