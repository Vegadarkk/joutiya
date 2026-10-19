// The door opening of the welcome threshold (design C7, Motion): one timeline of transform and
// opacity steps, played with the Web Animations API by src/components/welcome/welcome-dialog.tsx.
// The tagline and actions fade, the ochre leaf swings open on its hinge while the light rises in
// the doorway, then the camera pushes through the doorway and the ground fades on the home page.

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

export const DOOR_DURATION_MS = 1500;
/** Skip (click, tap, Escape) during the opening: a short fade to the end. */
export const SKIP_FADE_MS = 150;
/** prefers-reduced-motion: a crossfade, no swing, no push. */
export const REDUCED_FADE_MS = 200;

export type DoorPart = "copy" | "leaf" | "shade" | "light" | "spill" | "door" | "ground";

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
/** The camera: gathers, rushes through the doorway, eases into the room. */
const PUSH = "cubic-bezier(0.7, 0, 0.2, 1)";

const fade = (from: number, to: number): Keyframe[] => [{ opacity: from }, { opacity: to }];

/**
 * The opening. The leaf turns towards the viewer around its hinge: the start side of the doorway,
 * so left in French and right in Arabic, the angle mirrored with it.
 */
export function doorSteps({ rtl, scale }: { rtl: boolean; scale: number }): DoorStep[] {
  const angle = rtl ? 100 : -100;
  return [
    { part: "copy", keyframes: fade(1, 0), delay: 0, duration: 150, easing: "ease-out" },
    { part: "leaf", keyframes: [{ transform: "rotateY(0deg)" }, { transform: `rotateY(${angle}deg)` }], delay: 100, duration: 600, easing: SWING },
    { part: "shade", keyframes: fade(0, 1), delay: 100, duration: 600, easing: SWING },
    { part: "light", keyframes: fade(0, 1), delay: 100, duration: 600, easing: "ease-out" },
    { part: "spill", keyframes: fade(0, 1), delay: 250, duration: 550, easing: "ease-out" },
    { part: "door", keyframes: [{ transform: "scale(1)" }, { transform: `scale(${scale})` }], delay: 550, duration: 950, easing: PUSH },
    { part: "ground", keyframes: fade(1, 0), delay: 1100, duration: 400, easing: "ease-in-out" },
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
