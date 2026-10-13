import { notFound } from "next/navigation";

// Unknown localized paths render the localized 404 inside the site chrome.
export default function CatchAll() {
  notFound();
}
