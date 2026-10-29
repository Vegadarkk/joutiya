// Readable rounding of prices (pure, no import): the « Prix repère » range and the suggested
// amounts of an offer (a client island, kept light).

/**
 * Rounding step of prices around `value`: about two significant digits (350 -> 10, 85 000 -> 1 000),
 * halved when that would be too coarse (12 000 -> 500, 1 200 000 -> 50 000).
 */
export function roundingStep(value: number): number {
  if (!(value >= 10)) return 1;
  let step = 10 ** (Math.floor(Math.log10(value)) - 1);
  if (value / step < 30) step /= 2;
  return Math.max(1, step);
}
