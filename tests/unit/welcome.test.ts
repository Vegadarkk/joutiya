import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PINNED_SCRIPT_HASHES, scriptHash } from "@/lib/security/inline-hashes";
import { cycleFocus } from "@/lib/welcome/focus";
import { isHomePathname, queueDoorOpening, takeQueuedDoor, welcomeAfterSignIn } from "@/lib/welcome/flags";
import { DUST_COUNT, projectMote, scatterMotes } from "@/lib/welcome/dust";
import { DOOR_DURATION_MS, doorSteps, LEAF_OPEN_DEG, LEAF_STOP_DEG, MIN_PUSH_SCALE, PUSH_DELAY_MS, pushScale, REDUCED_FADE_MS, reducedSteps, stepsEnd } from "@/lib/welcome/motion";
import { doorTilt, MAX_TILT_DEG } from "@/lib/welcome/tilt";
import { CSRF_COOKIE } from "@/lib/security/cookies";
import { CRAWLER_AGENT, DOOR_FALLBACK_MS, HOME_PATH, SIGNED_IN_COOKIE, WELCOME_SCRIPT } from "@/lib/welcome/script";

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
  cookie?: string;
  /** CSS.supports("selector(:has(*))"). */
  has?: boolean;
  storage?: Record<string, string>;
  broken?: boolean;
}

/** Runs the inline script against a fake document; returns html[data-welcome], the storage and the timers after it. */
function run({ path, referrer = "", agent = CHROME, cookie = "", has = true, storage = {}, broken = false }: Visit) {
  const attributes = new Map<string, string>();
  const documentElement = {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
  };
  const document = { referrer, cookie, documentElement };
  const location = { pathname: path, origin: "https://joutiya.ma" };
  const localStorage = new MemoryStorage(storage, broken);
  const css = { supports: (condition: string) => condition === "selector(:has(*))" && has };
  const timers: { callback: () => void; delay: number }[] = [];
  const setTimeout = (callback: () => void, delay: number) => timers.push({ callback, delay });
  new Function("document", "location", "navigator", "localStorage", "CSS", "setTimeout", WELCOME_SCRIPT)(
    document,
    location,
    { userAgent: agent },
    localStorage,
    css,
    setTimeout,
  );
  return { state: attributes.get("data-welcome") ?? null, storage: Object.fromEntries(localStorage.items), timers, documentElement };
}

/** The state and storage of a visit, without its timers. */
const outcome = (visit: Visit) => {
  const { state, storage } = run(visit);
  return { state, storage };
};

describe("pre-paint script", () => {
  it("shows the screen on the first visit of a home page, and marks the device", () => {
    for (const path of ["/fr", "/fr/", "/ar", "/ar/", "/rif", "/rif/"]) {
      expect(outcome({ path }), path).toEqual({ state: "screen", storage: { welcome: "seen" } });
    }
    // Same-origin referrer (an internal link to home) still counts as a first visit.
    expect(run({ path: "/fr", referrer: "https://joutiya.ma/fr/legal/cgu" }).state).toBe("screen");
  });

  it("never shows it twice, on a deep link, to a crawler or to a visitor from another site", () => {
    expect(outcome({ path: "/fr", storage: { welcome: "seen" } })).toEqual({ state: null, storage: { welcome: "seen" } });
    for (const path of ["/", "/fr/recherche", "/fr/annonce/velo-ab12cd34", "/en", "/frx", "/fr//"]) {
      expect(outcome({ path }), path).toEqual({ state: null, storage: {} });
    }
    for (const agent of ["Mozilla/5.0 (compatible; Googlebot/2.1)", "facebookexternalhit/1.1", "WhatsApp/2.23", "TelegramBot (like TwitterBot)", "Mozilla/5.0 (compatible; bingbot/2.0)"]) {
      expect(run({ path: "/fr", agent }).state, agent).toBeNull();
    }
    expect(outcome({ path: "/fr", referrer: "https://www.google.com/" })).toEqual({ state: null, storage: {} });
  });

  it("skips the screen for a signed-in browser and where :has() is missing, never the door", () => {
    expect(outcome({ path: "/fr", cookie: `theme=dark; ${CSRF_COOKIE}=abc` })).toEqual({ state: null, storage: {} });
    expect(outcome({ path: "/fr", cookie: `${CSRF_COOKIE}=abc` }).state).toBeNull();
    // Another cookie ending with the same name is not the session's.
    expect(outcome({ path: "/fr", cookie: "x__Host-csrf=abc" }).state).toBe("screen");
    expect(outcome({ path: "/fr", has: false })).toEqual({ state: null, storage: {} });
    const queued = { welcome: "seen", door: "queued" };
    expect(outcome({ path: "/fr", cookie: `${CSRF_COOKIE}=abc`, has: false, storage: queued }).state).toBe("door");
  });

  it("opens the door once after a sign-in lands on home", () => {
    expect(outcome({ path: "/ar", storage: { welcome: "seen", door: "queued" } })).toEqual({ state: "door", storage: { welcome: "seen", door: "opened" } });
    expect(run({ path: "/ar", storage: { welcome: "seen", door: "opened" } }).state).toBeNull();
    // Queued on another page: it waits for the home page.
    expect(run({ path: "/fr/parametres", storage: { welcome: "seen", door: "queued" } }).storage.door).toBe("queued");
  });

  it("lets the page through when the door has not started in time, and only then", () => {
    const stuck = run({ path: "/fr", storage: { welcome: "seen", door: "queued" } });
    expect(stuck.timers.map((timer) => timer.delay)).toEqual([DOOR_FALLBACK_MS]);
    stuck.timers[0]?.callback();
    expect(stuck.documentElement.getAttribute("data-welcome")).toBeNull();
    const opening = run({ path: "/fr", storage: { welcome: "seen", door: "queued" } });
    opening.documentElement.setAttribute("data-welcome", "door open");
    opening.timers[0]?.callback();
    expect(opening.documentElement.getAttribute("data-welcome")).toBe("door open");
    // The screen waits for the visitor.
    expect(run({ path: "/fr" }).timers).toEqual([]);
  });

  it("does nothing when storage throws (private modes): the page shows as usual", () => {
    expect(run({ path: "/fr", broken: true }).state).toBeNull();
  });

  it("keeps the documented patterns and is pinned by hash for the public CSP", () => {
    expect(WELCOME_SCRIPT).toContain(HOME_PATH.source);
    expect(WELCOME_SCRIPT).toContain(CRAWLER_AGENT.source);
    expect(WELCOME_SCRIPT).toContain(SIGNED_IN_COOKIE.source);
    expect(WELCOME_SCRIPT).toContain(`},${DOOR_FALLBACK_MS})`);
    expect(SIGNED_IN_COOKIE.test(`${CSRF_COOKIE}=token`)).toBe(true);
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
  it("fits in 2.5 s, mirrors the swing in Arabic and animates transform and opacity only", () => {
    const ltr = doorSteps({ rtl: false, scale: MIN_PUSH_SCALE });
    const rtl = doorSteps({ rtl: true, scale: MIN_PUSH_SCALE });
    expect(stepsEnd(ltr)).toBe(DOOR_DURATION_MS);
    expect(stepsEnd(ltr)).toBeLessThanOrEqual(2500);
    expect(ltr.find((step) => step.part === "leaf")?.keyframes.at(-1)).toEqual({ transform: "rotateY(-100deg)" });
    expect(rtl.find((step) => step.part === "leaf")?.keyframes.at(-1)).toEqual({ transform: "rotateY(100deg)" });
    // Per-keyframe easing and offsets are timing, not animated properties.
    for (const step of ltr) for (const frame of step.keyframes) for (const key of Object.keys(frame)) expect(["transform", "opacity", "offset", "easing"]).toContain(key);
    expect(reducedSteps()).toEqual([expect.objectContaining({ part: "ground", duration: REDUCED_FADE_MS })]);
  });

  it("bumps the leaf against its stop before the push, the glint over by then", () => {
    const steps = doorSteps({ rtl: false, scale: MIN_PUSH_SCALE });
    const leaf = steps.find((step) => step.part === "leaf");
    const stop = leaf?.keyframes.find((frame) => frame.offset !== undefined);
    expect(stop?.transform).toBe(`rotateY(-${LEAF_STOP_DEG}deg)`);
    expect(LEAF_STOP_DEG).toBeGreaterThan(LEAF_OPEN_DEG);
    // The leaf reaches its stop before the camera moves.
    expect((leaf?.delay ?? 0) + (leaf?.duration ?? 0) * Number(stop?.offset)).toBeLessThan(PUSH_DELAY_MS);
    for (const name of ["glint", "sheen"] as const) {
      const step = steps.find((candidate) => candidate.part === name);
      expect((step?.delay ?? 0) + (step?.duration ?? 0), name).toBeLessThanOrEqual(PUSH_DELAY_MS);
    }
    // The shadow sweeps outwards: left of the hinge in French, right in Arabic.
    const cast = (rtl: boolean) => doorSteps({ rtl, scale: MIN_PUSH_SCALE }).find((step) => step.part === "cast")?.keyframes.at(-1)?.transform;
    expect(cast(false)).toContain("skewX(-");
    expect(cast(true)).not.toContain("skewX(-");
  });

  it("leans the door towards a mouse pointer, never past the maximum", () => {
    const door = { left: 400, top: 100, width: 300, height: 480 };
    const angle = (value: string) => Number(/(-?[\d.]+)deg$/.exec(value)?.[1]);
    expect(angle(doorTilt(door, { x: 550, y: 340 }))).toBe(0);
    const right = doorTilt(door, { x: 1100, y: 340 }).split(" ");
    // A pointer on the right: about the vertical axis.
    expect(right.slice(0, 3).map((value) => Math.abs(Number(value)))).toEqual([0, 1, 0]);
    expect(angle(doorTilt(door, { x: 5000, y: -5000 }))).toBeLessThanOrEqual(MAX_TILT_DEG);
  });

  it("floats the dust in the doorway, and lets the camera pass it during the push", () => {
    const door = { left: 100, top: 50, width: 240, height: 386 };
    const origin = { x: 220, y: 324 };
    let seed = 1;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const motes = scatterMotes(door, origin, random);
    expect(motes).toHaveLength(DUST_COUNT);
    for (const mote of motes) {
      // Inside the doorway (x 202.24-309.76 of the door's 136-376) at rest.
      expect(origin.x + mote.x).toBeGreaterThanOrEqual(door.left + 66);
      expect(origin.x + mote.x).toBeLessThanOrEqual(door.left + 174);
      expect(projectMote(mote, 1, 0)).not.toBeNull();
      // At the end of the push (16 times), the camera is beyond every mote.
      expect(projectMote(mote, 16, 2)).toBeNull();
    }
    const mote = motes[0];
    if (!mote) throw new Error("no mote");
    const near = projectMote(mote, 1.5, 0);
    const far = projectMote(mote, 1, 0);
    if (near && far) expect(Math.hypot(near.x, near.y)).toBeGreaterThan(Math.hypot(far.x, far.y));
  });

  it("never spells the brand: the inscription comes from the messages (rename without touching the door)", () => {
    const sources = ["src/components/welcome/door-scene.tsx", "src/components/welcome/welcome-threshold.tsx", "src/components/welcome/welcome-dialog.tsx", "src/lib/welcome/motion.ts"];
    for (const file of sources) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/joutiya|أعلان/i);
    }
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
