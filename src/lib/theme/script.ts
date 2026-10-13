// Pre-paint theme script (no flash of the wrong theme). A constant string: its hash is stable
// across builds, so public pages allow it by hash (src/lib/security/inline-hashes.ts) and
// private pages by nonce.

export const THEME_STORAGE_KEY = "theme";
export const THEME_ATTRIBUTE = "data-theme";

export const THEME_SCRIPT =
  '(function(){try{var c=localStorage.getItem("theme"),d=c==="dark"||(c!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches),e=document.documentElement;e.setAttribute("data-theme",d?"dark":"light");e.style.colorScheme=d?"dark":"light"}catch(_){}})()';
