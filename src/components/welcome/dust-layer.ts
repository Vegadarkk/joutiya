import { projectMote, scatterMotes } from "@/lib/welcome/dust";
import { DOOR_VIEWBOX, PUSH_POINT } from "@/lib/welcome/motion";

// The dust of the opening (src/lib/welcome/dust.ts): one small element per mote over the threshold,
// moved frame by frame from the door's own animations (the push gives the camera's travel, the light
// spilling out of the doorway how lit the motes are). Transform and opacity only, no canvas: a full-window canvas redrawn and
// uploaded every frame cost a low-end phone a third of its frames (measured, issue #199). Returns
// the function that stops it.

/** The size of a mote's element (globals.css .welcome-dust i), scaled to each mote's glow. */
const MOTE_PX = 16;

const progress = (animation: Animation) => animation.effect?.getComputedTiming().progress ?? 0;

export function playDust(layer: HTMLElement, door: DOMRect, push: Animation, spill: Animation, scale: number): () => void {
  if (!(door.width > 0)) return () => undefined;
  const unit = door.width / DOOR_VIEWBOX.width;
  const origin = { x: door.left + (PUSH_POINT.x - DOOR_VIEWBOX.x) * unit, y: door.top + (PUSH_POINT.y - DOOR_VIEWBOX.y) * unit };
  const motes = scatterMotes(door, origin).map((mote) => ({ mote, element: layer.appendChild(document.createElement("i")) }));
  layer.hidden = false;
  let frame = 0;
  const draw = () => {
    const time = spill.currentTime;
    const seconds = typeof time === "number" ? time / 1000 : 0;
    const lit = progress(spill);
    const zoom = 1 + (scale - 1) * progress(push);
    for (const { mote, element } of motes) {
      const shown = projectMote(mote, zoom, seconds);
      const alpha = shown ? lit * shown.fade * 0.8 : 0;
      element.style.opacity = alpha.toFixed(3);
      if (!shown || alpha < 0.01) continue;
      // The glow reaches beyond the mote itself.
      const size = (shown.radius * 5) / MOTE_PX;
      element.style.transform = `translate3d(${(origin.x + shown.x).toFixed(1)}px, ${(origin.y + shown.y).toFixed(1)}px, 0) scale(${size.toFixed(3)})`;
    }
    frame = window.requestAnimationFrame(draw);
  };
  frame = window.requestAnimationFrame(draw);
  return () => window.cancelAnimationFrame(frame);
}
