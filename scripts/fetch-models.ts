// Downloads the worker's local ONNX models (models/MANIFEST.json) into MEDIA_MODELS_DIR (default
// ./models), verifies each sha256 and skips files already present and valid. Node 24 built-ins only,
// erasable TypeScript: `node scripts/fetch-models.ts [--check]`. Nothing but the model files is
// written; the output names files and sizes only.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";

interface ManifestModel {
  name: string;
  file: string;
  url: string;
  sha256: string;
  bytes: number;
  licence: string;
}

interface Manifest {
  version: number;
  models: ManifestModel[];
}

const SHA256 = /^[0-9a-f]{64}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.onnx$/;
const MANIFEST_PATH = fileURLToPath(new URL("../models/MANIFEST.json", import.meta.url));

async function readManifest(): Promise<Manifest> {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as Manifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.models) || manifest.models.length === 0) throw new Error("models/MANIFEST.json: unsupported manifest");
  for (const model of manifest.models) {
    if (!FILE_NAME.test(model.file)) throw new Error(`models/MANIFEST.json: invalid file name for ${model.name}`);
    if (!SHA256.test(model.sha256)) throw new Error(`models/MANIFEST.json: invalid sha256 for ${model.name}`);
    if (!model.url.startsWith("https://")) throw new Error(`models/MANIFEST.json: ${model.name} must be fetched over https`);
    if (!Number.isInteger(model.bytes) || model.bytes <= 0) throw new Error(`models/MANIFEST.json: invalid byte count for ${model.name}`);
  }
  return manifest;
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function download(model: ManifestModel, target: string): Promise<void> {
  const part = `${target}.part`;
  await rm(part, { force: true });
  const response = await fetch(model.url, { redirect: "follow", headers: { accept: "application/octet-stream" } });
  if (!response.ok || !response.body) throw new Error(`${model.name}: download failed with HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 0 && length !== model.bytes) {
    await response.body.cancel();
    throw new Error(`${model.name}: server announces ${length} bytes, manifest says ${model.bytes}`);
  }
  try {
    await pipeline(Readable.fromWeb(response.body as WebReadableStream), createWriteStream(part, { flags: "wx" }));
    const digest = await sha256Of(part);
    const size = (await stat(part)).size;
    if (digest !== model.sha256 || size !== model.bytes) throw new Error(`${model.name}: checksum mismatch (got ${size} bytes, sha256 ${digest})`);
    await rename(part, target);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  const dir = path.resolve(process.env.MEDIA_MODELS_DIR || "models");
  const manifest = await readManifest();
  if (!checkOnly) await mkdir(dir, { recursive: true });
  let failures = 0;
  for (const model of manifest.models) {
    const target = path.join(dir, model.file);
    if (await exists(target)) {
      const digest = await sha256Of(target);
      if (digest === model.sha256) {
        console.log(`${model.name}\t${model.file}\t${(await stat(target)).size} bytes\tok (${model.licence})`);
        continue;
      }
      if (checkOnly) {
        console.error(`${model.name}\t${model.file}\tchecksum mismatch`);
        failures += 1;
        continue;
      }
      console.warn(`${model.name}\t${model.file}\tchecksum mismatch, downloading again`);
      await rm(target, { force: true });
    } else if (checkOnly) {
      console.error(`${model.name}\t${model.file}\tmissing`);
      failures += 1;
      continue;
    }
    await download(model, target);
    console.log(`${model.name}\t${model.file}\t${(await stat(target)).size} bytes\tdownloaded (${model.licence})`);
  }
  if (failures > 0) {
    console.error(`${failures} model file(s) missing or invalid under ${dir}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
