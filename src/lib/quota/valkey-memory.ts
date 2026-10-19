/** used_memory of a Valkey `INFO memory` reply, in bytes; null when the field is missing. */
export function usedMemoryBytes(info: string): number | null {
  const match = /^used_memory:(\d+)\r?$/m.exec(info);
  return match ? Number(match[1]) : null;
}
