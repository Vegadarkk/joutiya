import { cn } from "@/lib/utils";

/**
 * The door of the logo (public/brand/joutiya-icon.svg geometry): horseshoe pointed arch, khoukha,
 * eight-point door star and gold threshold. Used for empty states and brand moments instead of
 * stock illustrations.
 */
export function DoorMark({ className }: { className?: string }) {
  return (
    <svg viewBox="136 56 240 386" className={cn("h-auto w-24", className)} aria-hidden="true" focusable="false">
      <path
        className="fill-bab-700 dark:fill-bab-500"
        d="M160 419.92L160 267.23A136.32 136.32 0 0 1 256 62.8A136.32 136.32 0 0 1 352 267.23L352 419.92Z"
      />
      <path className="fill-cream-200" d="M186.88 419.92L186.88 259.39A109.44 109.44 0 0 1 256 90.09A109.44 109.44 0 0 1 325.12 259.39L325.12 419.92Z" />
      <path className="fill-ochre-500" d="M202.24 419.92L202.24 255.85A76.34 76.34 0 0 1 256 141.37A76.34 76.34 0 0 1 309.76 255.85L309.76 419.92Z" />
      <path
        className="fill-gold-400"
        d="M147.71 414.16H364.29A6.91 6.91 0 0 1 371.2 421.07V430.29A6.91 6.91 0 0 1 364.29 437.2H147.71A6.91 6.91 0 0 1 140.8 430.29V421.07A6.91 6.91 0 0 1 147.71 414.16Z"
      />
      <path
        className="fill-gold-400"
        d="M256 167.32L267.34 178.66L283.37 178.66L283.37 194.69L294.71 206.03L283.37 217.37L283.37 233.4L267.34 233.4L256 244.74L244.66 233.4L228.63 233.4L228.63 217.37L217.29 206.03L228.63 194.69L228.63 178.66L244.66 178.66Z"
      />
      <path
        className="fill-cream-200"
        d="M256 187.84L261.33 193.17L268.86 193.17L268.86 200.7L274.19 206.03L268.86 211.36L268.86 218.9L261.33 218.9L256 224.22L250.67 218.9L243.14 218.9L243.14 211.36L237.81 206.03L243.14 200.7L243.14 193.17L250.67 193.17Z"
      />
    </svg>
  );
}
