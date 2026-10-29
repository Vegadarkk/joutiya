// Dust in the doorway's light (issue #199): a few motes floating between the camera and the door,
// shown over the threshold (src/components/welcome/dust-layer.ts). They show as the
// light rises and the camera, pushing through the doorway, passes them: each one drifts outwards and
// grows, then is behind the viewer. Driven by the door's own animations, so a skip or a slow frame
// never puts them out of step. Never under reduced motion (no opening runs then).

import { DOOR_VIEWBOX, DOORWAY } from "@/lib/welcome/motion";

export const DUST_COUNT = 26;
/** Nearest and farthest mote, as a share of the camera's distance to the door. */
const NEAR = 0.38;
const FAR = 0.94;
/** A mote this close to the camera has passed it. */
const GONE = 0.03;

export interface Mote {
  /** Offset from the push point on screen at rest, in CSS px. */
  x: number;
  y: number;
  /** Distance from the camera, the door being at 1. */
  depth: number;
  /** Radius at rest, in CSS px. */
  size: number;
  /** Phase and speed of its sway. */
  phase: number;
  speed: number;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Motes inside the doorway as it shows on screen, around the push point (seeded: same for a given random). */
export function scatterMotes(door: Box, origin: { x: number; y: number }, random: () => number = Math.random): Mote[] {
  const unit = door.width / DOOR_VIEWBOX.width;
  const left = door.left + (DOORWAY.left - DOOR_VIEWBOX.x) * unit;
  const right = door.left + (DOORWAY.right - DOOR_VIEWBOX.x) * unit;
  // The arch's lower part and the doorway down to the threshold: where the light is.
  const top = door.top + (DOORWAY.top - 60 - DOOR_VIEWBOX.y) * unit;
  const bottom = door.top + (DOORWAY.bottom - DOOR_VIEWBOX.y) * unit;
  return Array.from({ length: DUST_COUNT }, () => {
    const depth = NEAR + (FAR - NEAR) * random();
    return {
      x: left + (right - left) * random() - origin.x,
      y: top + (bottom - top) * random() - origin.y,
      depth,
      size: Math.max(0.6, unit * (0.5 + random() * 0.9)),
      phase: random() * Math.PI * 2,
      speed: 0.4 + random() * 0.6,
    };
  });
}

/**
 * Where a mote shows when the door is scaled by `scale` around the push point, `seconds` into the
 * opening: the camera has travelled 1 - 1/scale of its distance to the door. Null once it has passed.
 */
export function projectMote(mote: Mote, scale: number, seconds: number): { x: number; y: number; radius: number; fade: number } | null {
  const travel = 1 - 1 / Math.max(1, scale);
  const distance = mote.depth - travel;
  if (distance <= GONE) return null;
  const zoom = mote.depth / distance;
  // A slow sway, and a slight rise in the warm air.
  const swayX = Math.sin(mote.phase + seconds * mote.speed * 1.7) * mote.size * 3;
  const swayY = Math.cos(mote.phase + seconds * mote.speed) * mote.size * 2 - seconds * mote.size * 4;
  return {
    x: (mote.x + swayX) * zoom,
    y: (mote.y + swayY) * zoom,
    radius: mote.size * Math.min(zoom, 12),
    // Out of focus and fading as it reaches the lens.
    fade: Math.min(1, (distance - GONE) / 0.12),
  };
}
