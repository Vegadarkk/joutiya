import type { CSSProperties } from "react";
import { DOOR_VIEWBOX, PUSH_POINT } from "@/lib/welcome/motion";

// The logo's door (public/brand/joutiya-icon.svg, same paths as DoorMark) in layers, so that it can
// open: the arch and its cream frame with a dark doorway behind, the light inside the doorway, the
// gold threshold, the pool of light on the ground, and the ochre leaf on top, an HTML element of its
// own (SVG children cannot turn in 3D) with a front and a back face. Parts are found by
// data-welcome-part (src/components/welcome/welcome-dialog.tsx). Decorative: the dialog is named by
// its tagline.

export const ARCH = "M160 419.92L160 267.23A136.32 136.32 0 0 1 256 62.8A136.32 136.32 0 0 1 352 267.23L352 419.92Z";
export const FRAME = "M186.88 419.92L186.88 259.39A109.44 109.44 0 0 1 256 90.09A109.44 109.44 0 0 1 325.12 259.39L325.12 419.92Z";
export const DOORWAY = "M202.24 419.92L202.24 255.85A76.34 76.34 0 0 1 256 141.37A76.34 76.34 0 0 1 309.76 255.85L309.76 419.92Z";
export const THRESHOLD =
  "M147.71 414.16H364.29A6.91 6.91 0 0 1 371.2 421.07V430.29A6.91 6.91 0 0 1 364.29 437.2H147.71A6.91 6.91 0 0 1 140.8 430.29V421.07A6.91 6.91 0 0 1 147.71 414.16Z";
export const STAR =
  "M256 167.32L267.34 178.66L283.37 178.66L283.37 194.69L294.71 206.03L283.37 217.37L283.37 233.4L267.34 233.4L256 244.74L244.66 233.4L228.63 233.4L228.63 217.37L217.29 206.03L228.63 194.69L228.63 178.66L244.66 178.66Z";
export const STAR_CORE =
  "M256 187.84L261.33 193.17L268.86 193.17L268.86 200.7L274.19 206.03L268.86 211.36L268.86 218.9L261.33 218.9L256 224.22L250.67 218.9L243.14 218.9L243.14 211.36L237.81 206.03L243.14 200.7L243.14 193.17L250.67 193.17Z";
/** The leaf: the doorway down to the threshold's top edge, so that it swings over the threshold. */
export const LEAF = "M202.24 414.16L202.24 255.85A76.34 76.34 0 0 1 256 141.37A76.34 76.34 0 0 1 309.76 255.85L309.76 414.16Z";
/** The leaf's bounding box: its horseshoe arch bulges 10.75 beyond the straight sides (x 202.24 and 309.76). */
export const LEAF_BOX = { x: 191.49, y: 141.37, width: 129.02, height: 272.79 } as const;
/** The hinge: the leaf's straight side, from the start edge of its box. */
const HINGE = (202.24 - LEAF_BOX.x) / LEAF_BOX.width;

const VIEWBOX = `${DOOR_VIEWBOX.x} ${DOOR_VIEWBOX.y} ${DOOR_VIEWBOX.width} ${DOOR_VIEWBOX.height}`;
const LEAF_VIEWBOX = `${LEAF_BOX.x} ${LEAF_BOX.y} ${LEAF_BOX.width} ${LEAF_BOX.height}`;

const percent = (value: number) => `${(value * 100).toFixed(3)}%`;
const toX = (value: number) => (value - DOOR_VIEWBOX.x) / DOOR_VIEWBOX.width;
const toY = (value: number) => (value - DOOR_VIEWBOX.y) / DOOR_VIEWBOX.height;

/** The camera pushes towards PUSH_POINT: the door scales around it. */
const DOOR_STYLE: CSSProperties = { transformOrigin: `${percent(toX(PUSH_POINT.x))} ${percent(toY(PUSH_POINT.y))}` };
/** The leaf's box within the door. */
const HINGE_STYLE = {
  "--welcome-hinge": percent(HINGE),
  left: percent(toX(LEAF_BOX.x)),
  top: percent(toY(LEAF_BOX.y)),
  width: percent(LEAF_BOX.width / DOOR_VIEWBOX.width),
  height: percent(LEAF_BOX.height / DOOR_VIEWBOX.height),
} as CSSProperties;

export function DoorScene() {
  return (
    <div className="welcome-door" data-welcome-part="door" style={DOOR_STYLE} aria-hidden="true">
      <svg className="welcome-layer" viewBox={VIEWBOX} focusable="false">
        <path className="fill-bab-700" d={ARCH} />
        <path className="fill-cream-200" d={FRAME} />
        {/* The room behind the door, before its light rises. */}
        <path className="fill-ochre-900" d={DOORWAY} />
      </svg>
      <svg className="welcome-layer welcome-light" data-welcome-part="light" viewBox={VIEWBOX} focusable="false">
        <defs>
          {/* Brightest on the camera's path: the push ends in the cream of the page. */}
          <radialGradient id="welcome-light" gradientUnits="userSpaceOnUse" cx={PUSH_POINT.x} cy={PUSH_POINT.y} r="190">
            <stop offset="0" className="welcome-light-core" />
            <stop offset="0.55" className="welcome-light-mid" />
            <stop offset="1" className="welcome-light-edge" />
          </radialGradient>
        </defs>
        {/* The stroke covers the doorway's anti-aliased edge, which the push magnifies. */}
        <path fill="url(#welcome-light)" stroke="url(#welcome-light)" strokeWidth="1.5" d={DOORWAY} />
      </svg>
      <svg className="welcome-layer" viewBox={VIEWBOX} focusable="false">
        <path className="fill-gold-400" d={THRESHOLD} />
      </svg>
      <div className="welcome-spill" data-welcome-part="spill" />
      <div className="welcome-hinge" style={HINGE_STYLE}>
        <div className="welcome-leaf" data-welcome-part="leaf">
          <div className="welcome-face">
            <svg className="welcome-layer" viewBox={LEAF_VIEWBOX} focusable="false">
              <path className="fill-ochre-500 stroke-ochre-500" strokeWidth="1" d={LEAF} />
              <path className="fill-gold-400" d={STAR} />
              <path className="fill-cream-200" d={STAR_CORE} />
            </svg>
            {/* Turning away from the light, the face darkens. */}
            <svg className="welcome-layer welcome-shade" data-welcome-part="shade" viewBox={LEAF_VIEWBOX} focusable="false">
              <path className="fill-bab-950" d={LEAF} />
            </svg>
          </div>
          <div className="welcome-face welcome-face-back">
            <svg className="welcome-layer" viewBox={LEAF_VIEWBOX} focusable="false">
              <path className="fill-ochre-800" d={LEAF} />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
