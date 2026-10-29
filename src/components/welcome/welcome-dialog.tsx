"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { takeQueuedDoor } from "@/lib/welcome/flags";
import { cycleFocus } from "@/lib/welcome/focus";
import { doorSteps, MIN_PUSH_SCALE, pushScale, reducedSteps, SKIP_FADE_MS, type DoorPart } from "@/lib/welcome/motion";
import { doorTilt } from "@/lib/welcome/tilt";
import { WELCOME_ATTRIBUTE, type WelcomeState } from "@/lib/welcome/script";
import { playDust } from "./dust-layer";

// The welcome threshold's behaviour; its markup and texts come from the server (welcome-threshold.tsx).
// The pre-paint script has already decided whether it shows (html[data-welcome]): without that
// state the overlay stays hidden and is removed once hydrated (returning visitor, client-side
// navigation to home). "screen": modal dialog, focus trapped, Escape or "Découvrir sans compte"
// opens the door. "door": the door opens at once (a sign-in just landed here). While it opens, any
// click, tap or Escape skips to a short fade. At the end the state goes, focus moves to #main.
// Issue #199: on the screen, the door leans a little towards a mouse pointer (never on touch or with
// reduced motion); while the door opens, dust floats in its light over the threshold.

type Phase = "pending" | "screen" | "door" | "opening" | "closing" | "done";

/** Added to the html state while the door opens: the page shows through (globals.css). */
const OPEN = "open";
/** Added once the ground fades: the scrollbar's room takes the page's colour. */
const LIT = "lit";
const DISCOVER = "[data-welcome-action='discover']";
const ACTIONS = "a[href], button:not([disabled])";

const part = (root: HTMLElement, name: DoorPart) => root.querySelector<HTMLElement>(`[data-welcome-part='${name}']`);

/** Focus moves to the page itself, without scrolling; tabindex only while it holds focus. */
function focusMain(): void {
  const main = document.getElementById("main");
  if (!main) return;
  if (!main.hasAttribute("tabindex")) {
    main.setAttribute("tabindex", "-1");
    main.addEventListener("blur", () => main.removeAttribute("tabindex"), { once: true });
  }
  main.focus({ preventScroll: true });
}

export function WelcomeDialog({ labelledBy, children }: { labelledBy: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const phase = useRef<Phase>("pending");
  const entry = useRef<WelcomeState>("screen");
  const animations = useRef<Animation[]>([]);
  const litTimer = useRef<number | undefined>(undefined);
  const unmountedState = useRef<string | null>(null);
  const dust = useRef<HTMLDivElement>(null);
  const stopDust = useRef<() => void>(() => undefined);
  const [done, setDone] = useState(false);

  const lit = useCallback(() => {
    window.clearTimeout(litTimer.current);
    // Unmounted on the way: the state has gone with it.
    if (!root.current) return;
    document.documentElement.setAttribute(WELCOME_ATTRIBUTE, `${entry.current} ${OPEN} ${LIT}`);
  }, []);

  const finish = useCallback((focus: boolean) => {
    if (phase.current === "done") return;
    phase.current = "done";
    window.clearTimeout(litTimer.current);
    stopDust.current();
    document.documentElement.removeAttribute(WELCOME_ATTRIBUTE);
    setDone(true);
    if (focus) focusMain();
  }, []);

  const open = useCallback(() => {
    const element = root.current;
    const html = document.documentElement;
    const state = phase.current;
    if (!element || (state !== "screen" && state !== "door")) return;
    phase.current = "opening";
    entry.current = state;
    html.setAttribute(WELCOME_ATTRIBUTE, `${state} ${OPEN}`);
    // The pressed action fades out: focus stays in the dialog until the page takes it.
    element.focus({ preventScroll: true });
    const door = part(element, "door");
    // The door comes back upright (its transition) while the copy fades.
    door?.style.removeProperty("rotate");
    const box = door?.getBoundingClientRect();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scale = box ? pushScale(box, { width: window.innerWidth, height: window.innerHeight }) : MIN_PUSH_SCALE;
    const steps = reduced ? reducedSteps() : doorSteps({ rtl: html.dir === "rtl", scale });
    const played = new Map<DoorPart, Animation>();
    animations.current = steps.flatMap((step) => {
      const target = step.part === "ground" ? element : part(element, step.part);
      if (!target) return [];
      const animation = target.animate(step.keyframes, { delay: step.delay, duration: step.duration, easing: step.easing, fill: "both" });
      played.set(step.part, animation);
      return [animation];
    });
    // The glint's masked copy of the tiles is done before the push: out of the frames it would cost.
    const sheen = part(element, "sheen");
    played.get("sheen")?.finished.then(
      () => sheen?.style.setProperty("display", "none"),
      () => undefined,
    );
    const push = played.get("door");
    const spill = played.get("spill");
    if (dust.current && box && push && spill) stopDust.current = playDust(dust.current, box, push, spill, scale);
    litTimer.current = window.setTimeout(lit, steps.find((step) => step.part === "ground")?.delay ?? 0);
    // A skip pauses these: its own fade then ends the threshold.
    Promise.all(animations.current.map((animation) => animation.finished)).then(
      () => finish(true),
      () => undefined,
    );
  }, [finish, lit]);

  const skip = useCallback(() => {
    const element = root.current;
    if (!element || phase.current !== "opening") return;
    phase.current = "closing";
    for (const animation of animations.current) animation.pause();
    lit();
    const from = Number(window.getComputedStyle(element).opacity);
    element
      .animate([{ opacity: from }, { opacity: 0 }], { duration: SKIP_FADE_MS, easing: "ease-out", fill: "forwards" })
      .finished.then(
        () => finish(true),
        () => undefined,
      );
  }, [finish, lit]);

  // Before paint: a sign-in that navigated here client-side (no pre-paint script ran) shows the door
  // from the first frame, not after a glimpse of the page.
  useLayoutEffect(() => {
    const html = document.documentElement;
    if (phase.current === "pending") {
      const element = root.current;
      if (!html.hasAttribute(WELCOME_ATTRIBUTE) && takeQueuedDoor()) html.setAttribute(WELCOME_ATTRIBUTE, "door");
      const state = html.getAttribute(WELCOME_ATTRIBUTE);
      // No state, or the visitor already went through by the #main link before hydration (globals.css).
      if (!element || (state !== "screen" && state !== "door") || window.location.hash === "#main") {
        finish(false);
        return;
      }
      phase.current = state;
      if (state === "door") open();
      else if (!element.contains(document.activeElement)) element.focus({ preventScroll: true });
    } else if (phase.current !== "done" && unmountedState.current) {
      // React strict mode mounts twice in development: the state the cleanup took away comes back.
      html.setAttribute(WELCOME_ATTRIBUTE, unmountedState.current);
    }
    return () => {
      // Unmounted on the way (an error boundary replaced the page): never leave the page hidden.
      if (phase.current === "done") return;
      unmountedState.current = html.getAttribute(WELCOME_ATTRIBUTE);
      html.removeAttribute(WELCOME_ATTRIBUTE);
    };
  }, [finish, open]);

  // The door leans towards a mouse pointer while the screen waits. Pointer events only write its
  // `rotate`, once a frame; its CSS transition smooths it (globals.css).
  useEffect(() => {
    const element = root.current;
    const door = element ? part(element, "door") : null;
    if (!door || done) return;
    const fine = window.matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)");
    if (!fine.matches) return;
    let frame = 0;
    let pointer: { x: number; y: number } | null = null;
    const lean = () => {
      frame = 0;
      if (phase.current !== "screen") return;
      if (!pointer) {
        door.style.removeProperty("rotate");
        return;
      }
      door.style.setProperty("rotate", doorTilt(door.getBoundingClientRect(), pointer));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(lean);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      pointer = { x: event.clientX, y: event.clientY };
      schedule();
    };
    const onLeave = () => {
      pointer = null;
      schedule();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, [done]);

  useEffect(() => () => stopDust.current(), []);

  useEffect(() => {
    if (done) return;
    function onKeyDown(event: KeyboardEvent) {
      const element = root.current;
      const state = phase.current;
      if (!element || state === "pending" || state === "done") return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (state === "opening") skip();
        else if (state !== "closing") open();
      } else if (event.key === "Tab") {
        // The page underneath is hidden; while the door opens, focus stays where it is.
        event.preventDefault();
        if (state !== "screen") return;
        const actions = [...element.querySelectorAll<HTMLElement>(ACTIONS)];
        const index = actions.indexOf(document.activeElement as HTMLElement);
        actions[cycleFocus(index, actions.length, event.shiftKey)]?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [done, open, skip]);

  function onClick(event: MouseEvent<HTMLDivElement>) {
    // "Découvrir sans compte" is a link to #main (it works before hydration, see globals.css).
    if (!(event.target as Element).closest(DISCOVER)) return;
    event.preventDefault();
    open();
  }

  if (done) return null;
  return (
    <div
      ref={root}
      className="welcome"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onClick={onClick}
      onPointerDown={skip}
    >
      {children}
      <div ref={dust} className="welcome-dust" hidden aria-hidden="true" />
    </div>
  );
}
