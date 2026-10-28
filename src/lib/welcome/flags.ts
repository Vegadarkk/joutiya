import { DOOR_OPENED, DOOR_QUEUED, DOOR_STORAGE_KEY, WELCOME_SEEN, WELCOME_STORAGE_KEY } from "./script";

// Device flags of the welcome threshold, written by the sign-in flow (the pre-paint script reads
// them: src/lib/welcome/script.ts). Storage can be missing or full (private modes): a failure only
// means the screen or the door may show again.

/** A device that signed in never gets the welcome screen. */
export function markWelcomeSeen(): void {
  try {
    window.localStorage.setItem(WELCOME_STORAGE_KEY, WELCOME_SEEN);
  } catch {
    // Storage unavailable.
  }
}

/** A sign-in or a new account is about to land on the home page: the door opens there, once per device. */
export function queueDoorOpening(): void {
  try {
    window.localStorage.setItem(WELCOME_STORAGE_KEY, WELCOME_SEEN);
    if (window.localStorage.getItem(DOOR_STORAGE_KEY) !== DOOR_OPENED) window.localStorage.setItem(DOOR_STORAGE_KEY, DOOR_QUEUED);
  } catch {
    // Storage unavailable.
  }
}

/**
 * A client-side navigation reached the home page (the pre-paint script only runs on a full load):
 * takes a queued door opening, marking it played. False when none is queued or storage fails.
 */
export function takeQueuedDoor(): boolean {
  try {
    if (window.localStorage.getItem(DOOR_STORAGE_KEY) !== DOOR_QUEUED) return false;
    window.localStorage.setItem(DOOR_STORAGE_KEY, DOOR_OPENED);
    return true;
  } catch {
    return false;
  }
}

/** A locale-free pathname of the i18n router ("/", "/?q=1", "/#x") that is the home page. */
export function isHomePathname(pathname: string): boolean {
  return /^\/(?:[?#]|$)/.test(pathname);
}

/** Flags for a completed sign-in about to navigate to `pathname` (locale-free). */
export function welcomeAfterSignIn(pathname: string): void {
  if (isHomePathname(pathname)) queueDoorOpening();
  else markWelcomeSeen();
}
