import { describe, expect, it } from "vitest";
import { parseStatus, promoteCommand } from "../../scripts/deploy-prod";

const id = (digit: string) => `sha256:${digit.repeat(64)}`;

describe("deploy-prod", () => {
  it("parses the VM status", () => {
    const text = JSON.stringify({ staging: { release: "0123456789ab", web: id("a"), worker: id("b") }, prod: { release: "", web: "", worker: "" } });
    expect(parseStatus(text).staging.release).toBe("0123456789ab");
    expect(() => parseStatus('{"staging":{}}')).toThrow(/staging is missing/);
  });

  it("promotes only a valid release with both image IDs", () => {
    expect(promoteCommand({ release: "0123456789ab", web: id("a"), worker: id("b") })).toBe(`promote 0123456789ab ${id("a")} ${id("b")}`);
    expect(() => promoteCommand({ release: "", web: id("a"), worker: id("b") })).toThrow(/no valid release/);
    expect(() => promoteCommand({ release: "0123456789ab; rm -rf /", web: id("a"), worker: id("b") })).toThrow(/no valid release/);
    expect(() => promoteCommand({ release: "0123456789ab", web: "", worker: id("b") })).toThrow(/image IDs/);
  });
});
