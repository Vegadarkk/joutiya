import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// load/staging-limits-*.sh (D17): staging runs the load test with the production limits, then gets
// its own back. The scripts must follow the Compose files.

function composeLimits(file: string): string[] {
  const lines: string[] = [];
  let service = "";
  for (const line of readFileSync(new URL(`../../docker/${file}`, import.meta.url), "utf8").split("\n")) {
    const name = /^ {2}([a-z][\w-]*):\s*$/.exec(line);
    if (name) service = name[1] as string;
    const limit = /limits: \{ cpus: "([\d.]+)", memory: (\w+) \}/.exec(line);
    if (limit) lines.push(`limit ${service} ${limit[1]} ${limit[2]}`);
  }
  return lines;
}

function scriptLimits(file: string): string[] {
  return readFileSync(new URL(`../../load/${file}`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("limit "));
}

describe("staging limits for the load test", () => {
  it("apply the production limits, then the staging ones, to every service", () => {
    expect(composeLimits("compose.prod.yml")).toHaveLength(6);
    expect(scriptLimits("staging-limits-prod.sh")).toEqual(composeLimits("compose.prod.yml"));
    expect(scriptLimits("staging-limits-reset.sh")).toEqual(composeLimits("compose.staging.yml"));
  });
});
