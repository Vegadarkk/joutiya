"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { THEME_ATTRIBUTE, THEME_STORAGE_KEY } from "@/lib/theme/script";

// Light (the default), dark or system, without a theming library: the stored choice and the system preference
// are external stores; THEME_SCRIPT applies them before paint, ThemeSync keeps them applied.

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener("change", listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", listener);
    window.removeEventListener("storage", listener);
  };
}

function storedChoice(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "dark" || value === "system" ? value : "light";
  } catch {
    return "light";
  }
}

const systemDark = () => window.matchMedia(DARK_QUERY).matches;

function apply(theme: ResolvedTheme): void {
  const root = document.documentElement;
  if (root.getAttribute(THEME_ATTRIBUTE) === theme) return;
  // No colour transitions while the whole page switches.
  root.classList.add("theme-switching");
  root.setAttribute(THEME_ATTRIBUTE, theme);
  root.style.colorScheme = theme;
  window.requestAnimationFrame(() => root.classList.remove("theme-switching"));
}

export function useTheme(): { theme: ThemeChoice; resolvedTheme: ResolvedTheme; setTheme: (choice: ThemeChoice) => void } {
  const theme = useSyncExternalStore(subscribe, storedChoice, () => "light" as const);
  const dark = useSyncExternalStore(subscribe, systemDark, () => false);
  const resolvedTheme: ResolvedTheme = theme === "system" ? (dark ? "dark" : "light") : theme;
  const setTheme = useCallback((choice: ThemeChoice) => {
    try {
      if (choice === "light") window.localStorage.removeItem(THEME_STORAGE_KEY);
      else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
    apply(choice === "system" ? (systemDark() ? "dark" : "light") : choice);
    notify();
  }, []);
  return { theme, resolvedTheme, setTheme };
}

/** Follows the system preference and changes made in other tabs. */
export function ThemeSync() {
  const { resolvedTheme } = useTheme();
  useEffect(() => apply(resolvedTheme), [resolvedTheme]);
  return null;
}
