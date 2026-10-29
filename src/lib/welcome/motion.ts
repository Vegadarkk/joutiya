// The door opening of the welcome threshold (design C7, Motion): one timeline of transform and
// opacity steps, played with the Web Animations API by src/components/welcome/welcome-dialog.tsx.
// The tagline and actions fade, the ochre leaf swings open on its hinge while the light rises in
// the doorway, then the camera pushes through the doorway, the inscription passing overhead, and the
// ground fades on the home page. Slowed on 20 Oct 2026 (owner: "trop rapide"): 2.4 s, was 1.5 s.
// Issue #199 (29 Oct 2026): the leaf bumps against its stop, a glint of the rising light crosses
// the gate's tiles, the leaf casts its shadow on the threshold and dust floats in the light
// (src/lib/welcome/dust.ts). The push waits 100 ms more, so that the bump shows before it: 2.5 s.

/** The door artwork, in the coordinates of public/brand/joutiya-icon.svg (the door and its threshold). */
export const DOOR_VIEWBOX = { x: 136, y: 56, width: 240, height: 386 } as const;
/** Rectangular part of the doorway: under the arch's springing line, down to the threshold. */
export const DOORWAY = { left: 202.24, right: 309.76, top: 255.85, bottom: 414.16 } as const;
/**
 * Where the camera pushes: the doorway's axis, at eye level. Same point as the transform-origin of
 * .welcome-door in globals.css (50% 70.98%).
 */
export const PUSH_POINT = { x: 256, y: 330 } as const;
/** The push always goes at least this far (design: ~16), further when the viewport needs it. */
export const MIN_PUSH_SCALE = 16;
const MAX_PUSH_SCALE = 64;

export const DOOR_DURATION_MS = 2500;
/** When the camera starts its push: the leaf has just hit its stop. */
export const PUSH_DELAY_MS = 1000;
/** Skip (click, tap, Escape) during the opening: a short fade to the end. */
export const SKIP_FADE_MS = 150;
/** prefers-reduced-motion: a crossfade, no swing, no push. */
export const REDUCED_FADE_MS = 200;

export type DoorPart = "copy" | "crest" | "leaf" | "shade" | "light" | "spill" | "cast" | "glint" | "sheen" | "door" | "ground";

export interface DoorStep {
  part: DoorPart;
  keyframes: Keyframe[];
  /** From the start of the opening, in ms. */
  delay: number;
  duration: number;
  easing: string;
}

/** A heavy leaf: slow off the latch, settling at the end of its swing. */
const SWING = "cubic-bezier(0.45, 0, 0.2, 1)";
/** The leaf comes off the latch and is still moving when it reaches its stop... */
const TO_STOP = "cubic-bezier(0.45, 0, 0.65, 0.8)";
/** ...from which it rebounds a little and settles. */
const REBOUND = "cubic-bezier(0.25, 0.6, 0.35, 1)";
/** The leaf's open angle, how far the stop lets it swing, and when in the swing it gets there. */
export const LEAF_OPEN_DEG = 100;
export const LEAF_STOP_DEG = 104;
const STOP_AT = 0.72;
/** The camera: gathers, rushes through the doorway, eases into the room. */
const PUSH = "cubic-bezier(0.7, 0, 0.2, 1)";

const fade = (from: number, to: number): Keyframe[] => [{ opacity: from }, { opacity: to }];

/**
 * The opening. The leaf turns towards the viewer around its hinge: the start side of the doorway,
 * so left in French and right in Arabic, the angle mirrored with it.
 */
export function doorSteps({ rtl, scale }: { rtl: boolean; scale: number }): DoorStep[] {
  const side = rtl ? 1 : -1;
  return [
    { part: "copy", keyframes: fade(1, 0), delay: 0, duration: 250, easing: "ease-out" },
    {
      part: "leaf",
      keyframes: [
        { transform: "rotateY(0deg)", easing: TO_STOP },
        { transform: `rotateY(${side * LEAF_STOP_DEG}deg)`, offset: STOP_AT, easing: REBOUND },
        { transform: `rotateY(${side * LEAF_OPEN_DEG}deg)` },
      ],
      delay: 150,
      duration: 1000,
      easing: "linear",
    },
    { part: "shade", keyframes: fade(0, 1), delay: 150, duration: 1000, easing: SWING },
    { part: "light", keyframes: fade(0, 1), delay: 150, duration: 1000, easing: "ease-out" },
    { part: "spill", keyframes: fade(0, 1), delay: 400, duration: 900, easing: "ease-out" },
    // The leaf's shadow on the threshold and the ground, swept outwards from the hinge with it.
    {
      part: "cast",
      keyframes: [
        { opacity: 0, transform: "scaleX(0.1) skewX(0deg)" },
        { opacity: 1, transform: `scaleX(1) skewX(${side * 38}deg)` },
      ],
      delay: 250,
      duration: 900,
      easing: SWING,
    },
    // A glint of the rising light: a ring from the doorway across the gate's tiles, over before the push.
    { part: "glint", keyframes: [{ transform: "scale(0.25)" }, { transform: "scale(1.7)" }], delay: 250, duration: 750, easing: "cubic-bezier(0.3, 0, 0.45, 1)" },
    { part: "sheen", keyframes: [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], delay: 250, duration: 750, easing: "ease-in-out" },
    // The camera rises through the gate: the inscription lifts away above it.
    {
      part: "crest",
      // No first keyframe: it starts from the frame its entrance reached (globals.css).
      keyframes: [{ opacity: 0, transform: "translateY(-40%) scale(1.25)" }],
      delay: 800,
      duration: 450,
      easing: "cubic-bezier(0.5, 0, 0.75, 0)",
    },
    { part: "door", keyframes: [{ transform: "scale(1)" }, { transform: `scale(${scale})` }], delay: PUSH_DELAY_MS, duration: 1500, easing: PUSH },
    { part: "ground", keyframes: fade(1, 0), delay: 1950, duration: 550, easing: "ease-in-out" },
  ];
}

/** prefers-reduced-motion: the whole threshold crossfades to the page. */
export function reducedSteps(): DoorStep[] {
  return [{ part: "ground", keyframes: fade(1, 0), delay: 0, duration: REDUCED_FADE_MS, easing: "linear" }];
}

/** When the last step ends, in ms. */
export function stepsEnd(steps: readonly DoorStep[]): number {
  return Math.max(0, ...steps.map((step) => step.delay + step.duration));
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Scale of the push for the door's box on screen (before any transform): the smallest that makes
 * the rectangular part of the doorway cover the whole viewport around PUSH_POINT, never under
 * MIN_PUSH_SCALE. A door with no box (not laid out) gets the minimum.
 */
export function pushScale(door: Box, viewport: { width: number; height: number }): number {
  const unit = door.width / DOOR_VIEWBOX.width;
  if (!(unit > 0) || viewport.width <= 0 || viewport.height <= 0) return MIN_PUSH_SCALE;
  const x = (value: number) => door.left + (value - DOOR_VIEWBOX.x) * unit;
  const y = (value: number) => door.top + (value - DOOR_VIEWBOX.y) * unit;
  const ox = x(PUSH_POINT.x);
  const oy = y(PUSH_POINT.y);
  // Each edge of the doorway, scaled around the origin, must pass the matching viewport edge.
  const needed = Math.max(
    ox / (ox - x(DOORWAY.left)),
    (viewport.width - ox) / (x(DOORWAY.right) - ox),
    oy / (oy - y(DOORWAY.top)),
    (viewport.height - oy) / (y(DOORWAY.bottom) - oy),
  );
  // 10% beyond the edges: the light reaches the corners before the ground fades.
  return Math.min(MAX_PUSH_SCALE, Math.max(MIN_PUSH_SCALE, Math.ceil(needed * 1.1)));
}
