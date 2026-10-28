import { refKey } from "@/lib/contracts/stock-import";

// Photos of an imported stock (design concession/concession.md §4), matched by file name in the
// browser: `DUS-041.jpg`, `DUS-041-1.jpg`, `DUS-041_2.jpeg`, `DUS-041 (3).png` go to the listing
// whose stock reference is DUS-041 (case ignored), ordered by their number, the unnumbered first.
// Client-safe and pure.

export interface PhotoFile {
  name: string;
}

export interface PhotoMatch<F extends PhotoFile> {
  /** Listing id -> its files, in display order. */
  byListing: Map<string, F[]>;
  /** Files whose name matches no reference. */
  unmatched: F[];
}

const PHOTO_NAME = /^(.*?)(?:[\s_-]+\(?(\d{1,2})\)?|\s*\((\d{1,2})\))?$/;

/** Reference part and position of a file name (`DUS-041-2.jpg` -> DUS-041, 2). */
export function photoNameParts(name: string): { base: string; position: number } {
  const stem = name.replace(/\.[^.]+$/, "").trim();
  const match = PHOTO_NAME.exec(stem);
  const number = match?.[2] ?? match?.[3];
  return number && match?.[1] ? { base: match[1], position: Number(number) } : { base: stem, position: 0 };
}

export function matchPhotos<F extends PhotoFile>(files: readonly F[], stock: readonly { id: string; ref: string }[]): PhotoMatch<F> {
  const byRef = new Map(stock.map((listing) => [refKey(listing.ref), listing.id]));
  const placed = new Map<string, { file: F; position: number }[]>();
  const unmatched: F[] = [];
  for (const file of files) {
    // A reference may itself end in digits (DUS-041): the whole name first, then without the number.
    const whole = byRef.get(refKey(file.name.replace(/\.[^.]+$/, "")));
    const parts = photoNameParts(file.name);
    const id = whole ?? byRef.get(refKey(parts.base));
    if (!id) {
      unmatched.push(file);
      continue;
    }
    const list = placed.get(id) ?? [];
    list.push({ file, position: whole ? 0 : parts.position });
    placed.set(id, list);
  }
  const byListing = new Map<string, F[]>();
  for (const [id, list] of placed) byListing.set(id, list.sort((a, b) => a.position - b.position || a.file.name.localeCompare(b.file.name)).map((item) => item.file));
  return { byListing, unmatched };
}
