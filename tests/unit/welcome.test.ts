import { afterEach, describe, expect, it } from "vitest";
import { PINNED_SCRIPT_HASHES, scriptHash } from "@/lib/security/inline-hashes";
import { cycleFocus } from "@/lib/welcome/focus";
import { isHomePathname, queueDoorOpening, takeQueuedDoor, welcomeAfterSignIn } from "@/lib/welcome/flags";
import { DOOR_DURATION_MS, doorSteps, MIN_PUSH_SCALE, pushScale, REDUCED_FADE_MS, reducedSteps, stepsEnd } from "@/lib/welcome/motion";
import { CRAWLER_AGENT, HOME_PATH, WELCOME_SCRIPT } from "@/lib/welcome/script";

// The welcome threshold of the home page (design C7): the pre-paint decision, the device flags
// written by the sign-in flow, the dialog's focus trap and the door's timeline.

class MemoryStorage {
  readonly items = new Map<string, string>();
  constructor(
    initial: Record<string, string> = {},
    private readonly broken = false,
  ) {
    for (const [key, value] of Object.entries(initial)) this.items.set(key, value);
  }
  getItem(key: string): string | null {
    if (this.broken) throw new Error("SecurityError");
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.broken) throw new Error("QuotaExceededError");
    this.items.set(key, value);
  }
}

const CHROME = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36";

interface Visit {
  path: string;
  referrer?: string;
  agent?: string;
  storage?: Record<string, string>;
  broken?: boolean;
}

/** Runs the inline script against a fake document; returns html[data-welcome] and the storage after it. */
function run({ path, referrer = "", agent = CHROME, storage = {}, broken = false }: Visit) {
  const attributes = new Map<string, string>();
  const document = { referrer, documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) } };
  const location = { pathname: path, origin: "https://joutiya.ma" };
  const localStorage = new MemoryStorage(storage, broken);
  new Function("document", "location", "navigator", "localStorage", WELCOME_SCRIPT)(document, location, { userAgent: agent }, localStorage);
  return { state: attributes.get("data-welcome") ?? null, storage: Object.fromEntries(localStorage.items) };
}

describe("pre-paint script", () => {
  it("shows the screen on the first visit of a home page, and marks the device", () => {
    for (const path of ["/fr", "/fr/", "/ar", "/ar/", "/rif", "/rif/"]) {
      expect(run({ path }), path).toEqual({ state: "screen", storage: { welcome: "seen" } });
    }
    // Same-origin referrer (an internal link to home) still counts as a first visit.
    expect(run({ path: "/fr", referrer: "https://joutiya.ma/fr/legal/cgu" }).state).toBe("screen");
  });

  it("never shows it twice, on a deep link, to a crawler or to a visitor from another site", () => {
    expect(run({ path: "/fr", storage: { welcome: "seen" } })).toEqual({ state: null, storage: { welcome: "seen" } });
    for (const path of ["/", "/fr/recherche", "/fr/annonce/velo-ab12cd34", "/en", "/frx", "/fr//"]) {
      expect(run({ path }), path).toEqual({ state: null, storage: {} });
    }
    for (const agent of ["Mozilla/5.0 (compatible; Googlebot/2.1)", "facebookexternalhit/1.1", "WhatsApp/2.23", "TelegramBot (like TwitterBot)", "Mozilla/5.0 (compatible; bingbot/2.0)"]) {
      expect(run({ path: "/fr", agent }).state, agent).toBeNull();
    }
    expect(run({ path: "/fr", referrer: "https://www.google.com/" })).toEqual({ state: null, storage: {} });
  });

  it("opens the door once after a sign-in lands on home", () => {
    expect(run({ path: "/ar", storage: { welcome: "seen", door: "queued" } })).toEqual({ state: "door", storage: { welcome: "seen", door: "opened" } });
    expect(run({ path: "/ar", storage: { welcome: "seen", door: "opened" } }).state).toBeNull();
    // Queued on another page: it waits for the home page.
    expect(run({ path: "/fr/parametres", storage: { welcome: "seen", door: "queued" } }).storage.door).toBe("queued");
  });

  it("does nothing when storage throws (private modes): the page shows as usual", () => {
    expect(run({ path: "/fr", broken: true }).state).toBeNull();
  });

  it("keeps the documented patterns and is pinned by hash for the public CSP", () => {
    expect(WELCOME_SCRIPT).toContain(HOME_PATH.source);
    expect(WELCOME_SCRIPT).toContain(CRAWLER_AGENT.source);
    expect(PINNED_SCRIPT_HASHES.has(scriptHash(WELCOME_SCRIPT))).toBe(true);
  });
});

describe("sign-in flags", () => {
  const original = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    (globalThis as { window?: unknown }).window = original;
  });
  const device = (initial: Record<string, string> = {}, broken = false) => {
    const localStorage = new MemoryStorage(initial, broken);
    (globalThis as { window?: unknown }).window = { localStorage };
    return localStorage.items;
  };

  it("queues the door when the sign-in lands on home, else only skips the welcome screen", () => {
    expect(isHomePathname("/")).toBe(true);
    expect(isHomePathname("/?q=velo")).toBe(true);
    expect(isHomePathname("/parametres")).toBe(false);
    let items = device();
    welcomeAfterSignIn("/");
    expect(Object.fromEntries(items)).toEqual({ welcome: "seen", door: "queued" });
    items = device();
    welcomeAfterSignIn("/parametres");
    expect(Object.fromEntries(items)).toEqual({ welcome: "seen" });
  });

  it("plays the door once per device", () => {
    const items = device({ welcome: "seen", door: "opened" });
    queueDoorOpening();
    expect(items.get("door")).toBe("opened");
  });

  it("never throws without storage", () => {
    device({}, true);
    expect(() => welcomeAfterSignIn("/")).not.toThrow();
    expect(takeQueuedDoor()).toBe(false);
  });

  it("hands a queued door to a client-side arrival on home, once", () => {
    const items = device({ welcome: "seen", door: "queued" });
    expect(takeQueuedDoor()).toBe(true);
    expect(items.get("door")).toBe("opened");
    expect(takeQueuedDoor()).toBe(false);
  });
});

describe("focus trap", () => {
  it("cycles through the actions both ways and enters at the ends", () => {
    expect(cycleFocus(0, 3, false)).toBe(1);
    expect(cycleFocus(2, 3, false)).toBe(0);
    expect(cycleFocus(0, 3, true)).toBe(2);
    expect(cycleFocus(-1, 3, false)).toBe(0);
    expect(cycleFocus(-1, 3, true)).toBe(2);
    expect(cycleFocus(0, 0, false)).toBe(-1);
  });
});

describe("door timeline", () => {
  it("fits in 1.6 s, mirrors the swing in Arabic and animates transform and opacity only", () => {
    const ltr = doorSteps({ rtl: false, scale: MIN_PUSH_SCALE });
    const rtl = doorSteps({ rtl: true, scale: MIN_PUSH_SCALE });
    expect(stepsEnd(ltr)).toBe(DOOR_DURATION_MS);
    expect(stepsEnd(ltr)).toBeLessThanOrEqual(1600);
    expect(ltr.find((step) => step.part === "leaf")?.keyframes.at(-1)).toEqual({ transform: "rotateY(-100deg)" });
    expect(rtl.find((step) => step.part === "leaf")?.keyframes.at(-1)).toEqual({ transform: "rotateY(100deg)" });
    for (const step of ltr) for (const frame of step.keyframes) for (const key of Object.keys(frame)) expect(["transform", "opacity"]).toContain(key);
    expect(reducedSteps()).toEqual([expect.objectContaining({ part: "ground", duration: REDUCED_FADE_MS })]);
  });

  it("pushes far enough for the doorway to cover the viewport, at least 16 times", () => {
    const phone = { width: 390, height: 844 };
    // Door 52svh high on a phone, centred.
    const height = 0.52 * phone.height;
    const width = (height * 240) / 386;
    const door = { left: (phone.width - width) / 2, top: 80, width, height };
    const scale = pushScale(door, phone);
    expect(scale).toBeGreaterThanOrEqual(MIN_PUSH_SCALE);
    expect(pushScale({ left: 0, top: 0, width: 0, height: 0 }, phone)).toBe(MIN_PUSH_SCALE);
    // A wide desktop needs more than a phone for the same door.
    expect(pushScale({ ...door, left: (1920 - width) / 2 }, { width: 1920, height: 1080 })).toBeGreaterThanOrEqual(scale);
  });
});
