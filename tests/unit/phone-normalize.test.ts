import { describe, expect, it } from "vitest";
import { HttpError } from "@/lib/http/errors";
import { displayPhone, MOROCCAN_MOBILE_E164, normalizeMoroccanMobile } from "@/lib/phone/normalize";

function codeOf(input: string): string {
  try {
    normalizeMoroccanMobile(input);
  } catch (error) {
    if (error instanceof HttpError) return `${error.status} ${error.code}`;
    throw error;
  }
  return "accepted";
}

describe("normalizeMoroccanMobile", () => {
  it.each([
    ["0612345678", "+212612345678", "06 12 34 56 78"],
    ["06 12 34 56 78", "+212612345678", "06 12 34 56 78"],
    ["06.12.34.56.78", "+212612345678", "06 12 34 56 78"],
    ["06-12-34-56-78", "+212612345678", "06 12 34 56 78"],
    ["+212612345678", "+212612345678", "06 12 34 56 78"],
    ["+212 6 12 34 56 78", "+212612345678", "06 12 34 56 78"],
    ["00212712345678", "+212712345678", "07 12 34 56 78"],
    ["212612345678", "+212612345678", "06 12 34 56 78"],
    ["  0712345678  ", "+212712345678", "07 12 34 56 78"],
  ])("accepts %s", (input, e164, national) => {
    expect(normalizeMoroccanMobile(input)).toEqual({ e164, national });
    expect(MOROCCAN_MOBILE_E164.test(e164)).toBe(true);
  });

  it("refuses landlines and non-mobile ranges with phone_not_mobile", () => {
    expect(codeOf("0512345678")).toBe("400 phone_not_mobile");
    expect(codeOf("+212528812345")).toBe("400 phone_not_mobile");
    expect(codeOf("05 22 12 34 56")).toBe("400 phone_not_mobile");
    expect(codeOf("0812345678")).toBe("400 phone_not_mobile");
  });

  it("refuses invalid and foreign numbers with phone_invalid", () => {
    expect(codeOf("123")).toBe("400 phone_invalid");
    expect(codeOf("123456789")).toBe("400 phone_invalid");
    expect(codeOf("0912345678")).toBe("400 phone_invalid");
    expect(codeOf("")).toBe("400 phone_invalid");
    expect(codeOf("0612345")).toBe("400 phone_invalid");
    expect(codeOf("06123456789")).toBe("400 phone_invalid");
    expect(codeOf("+33612345678")).toBe("400 phone_invalid");
    expect(codeOf("0033612345678")).toBe("400 phone_invalid");
    expect(codeOf("0612345678x")).toBe("400 phone_invalid");
    expect(codeOf("06 12 34 56 78 ext 1")).toBe("400 phone_invalid");
    expect(codeOf("abc")).toBe("400 phone_invalid");
  });
});

describe("displayPhone", () => {
  it("formats a Moroccan E.164 number nationally", () => {
    expect(displayPhone("+212612345678")).toBe("06 12 34 56 78");
    expect(displayPhone("+212700000000")).toBe("07 00 00 00 00");
  });

  it("returns other values unchanged", () => {
    expect(displayPhone("+33612345678")).toBe("+33612345678");
    expect(displayPhone("")).toBe("");
  });
});
