/**
 * Focus trap of the welcome dialog: the index of the action that Tab (or Shift+Tab) moves to among
 * `count` actions, wrapping at both ends. `index` -1 means focus is on the dialog itself or outside
 * it: Tab enters on the first action, Shift+Tab on the last. -1 when there is nothing to focus.
 */
export function cycleFocus(index: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (index < 0 || index >= count) return backwards ? count - 1 : 0;
  return (index + (backwards ? count - 1 : 1)) % count;
}
