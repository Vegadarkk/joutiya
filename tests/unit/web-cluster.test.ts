import { describe, expect, it } from "vitest";
import { MAX_WEB_PROCESSES, webProcessCount } from "../../src/server/web-cluster.ts";

// src/server/web-cluster.ts: how many Next.js servers the web image starts.

describe("webProcessCount", () => {
  it("defaults to one process", () => {
    expect(webProcessCount(undefined)).toBe(1);
    expect(webProcessCount(" ")).toBe(1);
  });

  it("accepts 1 to the maximum", () => {
    expect(webProcessCount("2")).toBe(2);
    expect(webProcessCount(String(MAX_WEB_PROCESSES))).toBe(MAX_WEB_PROCESSES);
  });

  it("refuses anything else rather than guessing", () => {
    for (const value of ["0", "-1", "1.5", "two", String(MAX_WEB_PROCESSES + 1)]) expect(() => webProcessCount(value)).toThrow(RangeError);
  });
});
