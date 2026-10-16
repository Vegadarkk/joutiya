import { afterEach, describe, expect, it } from "vitest";
import { resetServerEnv } from "@/lib/env";
import { DEV_DISPLAY_NUMBER, isPhoneVerificationConfigured, whatsappDisplayNumber } from "@/lib/phone-verify/config";

// The feature is "configured" only when a challenge can be completed: the webhook needs the app
// secret and the phone number id, the page needs the display number.

const NAMES = ["APP_ENV", "WHATSAPP_DISPLAY_NUMBER", "WHATSAPP_APP_SECRET", "WHATSAPP_PHONE_NUMBER_ID"] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

function withEnv(values: Partial<Record<(typeof NAMES)[number], string>>): void {
  for (const name of NAMES) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetServerEnv();
}

afterEach(() => {
  withEnv(saved as Partial<Record<(typeof NAMES)[number], string>>);
});

describe("isPhoneVerificationConfigured", () => {
  it("needs the display number, the app secret and the phone number id together", () => {
    withEnv({ APP_ENV: "staging", WHATSAPP_DISPLAY_NUMBER: "212600000000", WHATSAPP_APP_SECRET: "s", WHATSAPP_PHONE_NUMBER_ID: "1" });
    expect(isPhoneVerificationConfigured()).toBe(true);
    withEnv({ APP_ENV: "staging", WHATSAPP_APP_SECRET: "s", WHATSAPP_PHONE_NUMBER_ID: "1" });
    expect(isPhoneVerificationConfigured()).toBe(false);
    withEnv({ APP_ENV: "staging", WHATSAPP_DISPLAY_NUMBER: "212600000000", WHATSAPP_PHONE_NUMBER_ID: "1" });
    expect(isPhoneVerificationConfigured()).toBe(false);
    withEnv({ APP_ENV: "staging", WHATSAPP_DISPLAY_NUMBER: "212600000000", WHATSAPP_APP_SECRET: "s" });
    expect(isPhoneVerificationConfigured()).toBe(false);
  });

  it("in development, falls back to the placeholder number but still needs the webhook credentials", () => {
    withEnv({ APP_ENV: "dev" });
    expect(whatsappDisplayNumber()).toBe(DEV_DISPLAY_NUMBER);
    expect(isPhoneVerificationConfigured()).toBe(false);
    withEnv({ APP_ENV: "dev", WHATSAPP_APP_SECRET: "s", WHATSAPP_PHONE_NUMBER_ID: "1" });
    expect(isPhoneVerificationConfigured()).toBe(true);
  });

  it("keeps only the digits of the display number", () => {
    withEnv({ APP_ENV: "staging", WHATSAPP_DISPLAY_NUMBER: "+212 6 00 00 00 00" });
    expect(whatsappDisplayNumber()).toBe("212600000000");
    withEnv({ APP_ENV: "staging", WHATSAPP_DISPLAY_NUMBER: "+-" });
    expect(whatsappDisplayNumber()).toBeUndefined();
  });
});
