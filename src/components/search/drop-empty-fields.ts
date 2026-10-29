/** Drops the empty fields of a submitted GET form (`?q=&ville=x` -> `?ville=x`). */
export function dropEmptyFields(data: FormData): void {
  for (const [key, value] of [...data.entries()]) {
    if (typeof value === "string" && !value.trim()) data.delete(key);
  }
}
