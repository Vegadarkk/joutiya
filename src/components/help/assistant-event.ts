// Opens the Assistant Joutiya widget of the help pages (design phase-5 D25). The account menu's
// help entry links to /aide#assistant and fires this event, which also covers a click made while
// already on a help page (a same-page hash navigation fires no hashchange).

export const ASSISTANT_HASH = "#assistant";
export const OPEN_ASSISTANT_EVENT = "joutiya:open-assistant";

export function openAssistant(): void {
  window.dispatchEvent(new Event(OPEN_ASSISTANT_EVENT));
}
