import { resizeWithOffscreenCanvas } from "./resize-core";

// Module Web Worker of the photo uploader (design D6): keeps decoding and re-encoding off the main
// thread of a low-end phone. Created by prepare-image.ts with `new Worker(new URL(...), { type: "module" })`.

interface Request {
  id: number;
  blob: Blob;
  maxEdge: number;
  type: string;
  quality: number;
}

const scope = self as unknown as { addEventListener(type: "message", listener: (event: MessageEvent<Request>) => void): void; postMessage(message: unknown): void };

scope.addEventListener("message", (event) => {
  const { id, blob, maxEdge, type, quality } = event.data;
  resizeWithOffscreenCanvas({ blob, maxEdge, type, quality }).then(
    (result) => scope.postMessage({ id, ok: true, ...result }),
    (error: unknown) => scope.postMessage({ id, ok: false, error: error instanceof Error ? error.message : "resize failed" }),
  );
});
