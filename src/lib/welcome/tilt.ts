// The door leaning towards a mouse pointer on the welcome screen (issue #199): it turns a little to
// face it, up to MAX_TILT_DEG when the pointer is about a door's width beside it or its height above. One CSS `rotate`
// (axis and angle), so that it composes with the transforms of the entrance and the push.

export const MAX_TILT_DEG = 4;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp = (value: number) => Math.min(1, Math.max(-1, value));

/** The `rotate` value for a pointer at `pointer` and a door at `door` (viewport px). */
export function doorTilt(door: Box, pointer: { x: number; y: number }): string {
  const dx = clamp((pointer.x - (door.left + door.width / 2)) / Math.max(1, door.width * 1.25));
  const dy = clamp((pointer.y - (door.top + door.height / 2)) / Math.max(1, door.height * 0.8));
  // Facing a pointer on the right turns the door about the vertical axis, one above about the horizontal one.
  const x = -dy;
  const y = dx;
  const length = Math.hypot(x, y);
  if (length < 0.001) return "0 1 0 0deg";
  const angle = Math.min(1, length) * MAX_TILT_DEG;
  return `${(x / length).toFixed(3)} ${(y / length).toFixed(3)} 0 ${angle.toFixed(2)}deg`;
}
