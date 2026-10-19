import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI } from "@/config/ai";
import type { ServerEnv } from "@/lib/env";

// The image classifiers: output decoding on synthetic tensors, the stub, the factory's choice by
// model presence, and (only where scripts/fetch-models.ts ran) the real ONNX models on generated
// images. CI has no model files: that block skips itself.

const logger = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() }));
vi.mock("@/lib/logging/logger", () => ({ logger }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));

const { alert } = await import("@/lib/alert");
const {
  checkModelsAtStartup,
  ClassifierUnavailableError,
  createImageClassifier,
  decodeYunet,
  imageClassifier,
  MODEL_FILES,
  MODELS_MISSING_ALERT_TITLE,
  modelPaths,
  modelsDir,
  modelsPresent,
  nonMaximumSuppression,
  OnnxImageClassifier,
  resetImageClassifier,
  softmax2,
  StubImageClassifier,
  UnavailableImageClassifier,
} = await import("@/lib/media/classify");
const { sharp } = await import("@/lib/media/sharp-setup");

const repoRoot = path.resolve(import.meta.dirname, "../..");
const repoModels = path.join(repoRoot, "models");
const env = (overrides: Partial<Pick<ServerEnv, "APP_ENV" | "MEDIA_MODELS_DIR">> = {}): Pick<ServerEnv, "APP_ENV" | "MEDIA_MODELS_DIR"> => ({ APP_ENV: "dev", MEDIA_MODELS_DIR: undefined, ...overrides });

/** Synthetic YuNet outputs with the given cells lit (stride, index, cls, obj, bbox). */
function yunetOutputs(cells: { stride: 8 | 16 | 32; index: number; cls: number; obj: number; bbox?: [number, number, number, number] }[]) {
  const outputs: Record<string, { data: Float32Array }> = {};
  for (const stride of [8, 16, 32]) {
    const count = (640 / stride) ** 2;
    outputs[`cls_${stride}`] = { data: new Float32Array(count) };
    outputs[`obj_${stride}`] = { data: new Float32Array(count) };
    outputs[`bbox_${stride}`] = { data: new Float32Array(count * 4) };
    outputs[`kps_${stride}`] = { data: new Float32Array(count * 10) };
  }
  for (const cell of cells) {
    outputs[`cls_${cell.stride}`]!.data[cell.index] = cell.cls;
    outputs[`obj_${cell.stride}`]!.data[cell.index] = cell.obj;
    const [dx, dy, lw, lh] = cell.bbox ?? [0.5, 0.5, Math.log(4), Math.log(4)];
    outputs[`bbox_${cell.stride}`]!.data.set([dx, dy, lw, lh], cell.index * 4);
  }
  return outputs;
}

beforeEach(() => {
  logger.warn.mockReset();
  logger.error.mockReset();
  vi.mocked(alert).mockClear();
});

describe("output decoding", () => {
  it("softmax2 returns the probability of index 0", () => {
    expect(softmax2(new Float32Array([0, 0]))).toBeCloseTo(0.5, 6);
    expect(softmax2(new Float32Array([2.0990729, 0.7923109]))).toBeCloseTo(0.787, 2);
    expect(softmax2(new Float32Array([0.7923109, 2.0990729]))).toBeCloseTo(0.213, 2);
    expect(softmax2(new Float32Array([1000, -1000]))).toBe(1);
    expect(softmax2([-50, 50])).toBeCloseTo(0, 10);
  });

  it("decodeYunet turns cls x obj into scores, decodes boxes per stride and applies NMS", () => {
    // Cell 0 of stride 32 covers the top-left corner: centre (0.5 * 32, 0.5 * 32), size 4 * 32.
    const one = decodeYunet(yunetOutputs([{ stride: 32, index: 0, cls: 0.9, obj: 0.9 }]), DEFAULT_AI.face.minConfidence);
    expect(one).toHaveLength(1);
    expect(one[0]!.score).toBeCloseTo(0.9, 6);
    expect(one[0]!.box.map((v) => Math.round(v * 640))).toEqual([-48, -48, 80, 80]);
    // Two cells describing the same face: one survives NMS.
    const overlapping = decodeYunet(yunetOutputs([{ stride: 32, index: 0, cls: 0.9, obj: 0.9 }, { stride: 16, index: 1, cls: 0.8, obj: 0.8, bbox: [0, 1, Math.log(8), Math.log(8)] }]), 0.6);
    expect(overlapping).toHaveLength(1);
    expect(overlapping[0]!.score).toBeCloseTo(0.9, 6);
    // Two distant faces at different strides: both kept; a weak cell is dropped by the threshold.
    const two = decodeYunet(yunetOutputs([{ stride: 32, index: 0, cls: 0.9, obj: 0.9 }, { stride: 8, index: 79 * 80 + 79, cls: 0.7, obj: 0.7 }, { stride: 16, index: 800, cls: 0.5, obj: 0.5 }]), 0.6);
    expect(two.map((face) => Number(face.score.toFixed(2)))).toEqual([0.9, 0.7]);
    // Scores are clamped to [0, 1] before the geometric mean.
    expect(decodeYunet(yunetOutputs([{ stride: 8, index: 5, cls: 3, obj: 2 }]), 0.99)[0]!.score).toBe(1);
    expect(() => decodeYunet({ cls_8: { data: new Float32Array(1) } }, 0.6)).toThrow(/missing outputs/);
  });

  it("nonMaximumSuppression keeps the best of overlapping boxes", () => {
    const kept = nonMaximumSuppression([
      { score: 0.7, box: [0, 0, 0.5, 0.5] },
      { score: 0.9, box: [0.05, 0.05, 0.55, 0.55] },
      { score: 0.8, box: [0.6, 0.6, 1, 1] },
    ]);
    expect(kept.map((face) => face.score)).toEqual([0.9, 0.8]);
  });
});

describe("StubImageClassifier", () => {
  it("answers fixed or computed results and counts calls", async () => {
    const clean = new StubImageClassifier();
    expect(await clean.classify(Buffer.alloc(1))).toEqual({ nsfw: 0, faces: 0 });
    const fixed = new StubImageClassifier({ nsfw: 0.91, faces: 2 });
    expect(await fixed.classify(Buffer.alloc(1))).toEqual({ nsfw: 0.91, faces: 2 });
    const computed = new StubImageClassifier((image) => ({ nsfw: image.byteLength / 10, faces: 0 }));
    expect(await computed.classify(Buffer.alloc(5))).toEqual({ nsfw: 0.5, faces: 0 });
    expect(computed.calls).toBe(1);
    expect(clean.name).toBe("stub");
  });
});

describe("createImageClassifier", () => {
  const dirs: string[] = [];
  const temp = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "joutiya-models-"));
    dirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  afterEach(async () => {
    await resetImageClassifier();
  });

  it("names the model files of models/MANIFEST.json", () => {
    const manifest = JSON.parse(readFileSync(path.join(repoModels, "MANIFEST.json"), "utf8")) as { models: { name: string; file: string; sha256: string; licence: string; url: string }[] };
    expect(manifest.models.map((model) => [model.name, model.file])).toEqual([
      ["nsfw", MODEL_FILES.nsfw],
      ["face", MODEL_FILES.face],
    ]);
    for (const model of manifest.models) {
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.url).toMatch(/^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\//);
      expect(["Apache-2.0", "MIT"]).toContain(model.licence);
    }
    expect(modelsDir(env())).toBe(path.resolve("models"));
    expect(modelsDir(env({ MEDIA_MODELS_DIR: "/app/models" }))).toBe("/app/models");
    expect(modelPaths("/app/models")).toEqual({ nsfw: "/app/models/nsfw-marqo-384.onnx", face: "/app/models/yunet-2023mar.onnx" });
  });

  it("falls back to the stub without model files in dev only, silently", () => {
    const dir = temp();
    expect(modelsPresent(dir)).toBe(false);
    expect(createImageClassifier(env({ MEDIA_MODELS_DIR: dir }), DEFAULT_AI)).toBeInstanceOf(StubImageClassifier);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    // One file is not enough.
    writeFileSync(path.join(dir, MODEL_FILES.nsfw), "");
    expect(modelsPresent(dir)).toBe(false);
    expect(createImageClassifier(env({ APP_ENV: "prod", MEDIA_MODELS_DIR: dir }), DEFAULT_AI)).toBeInstanceOf(UnavailableImageClassifier);
  });

  it("fails closed when deployed without the models: every check throws and alerts, never a clean answer", async () => {
    const dir = temp();
    for (const APP_ENV of ["staging", "prod"] as const) {
      const classifier = createImageClassifier(env({ APP_ENV, MEDIA_MODELS_DIR: dir }), DEFAULT_AI);
      expect(classifier).toBeInstanceOf(UnavailableImageClassifier);
      expect(classifier.name).toBe("unavailable");
      await expect(classifier.classify(Buffer.from("image"))).rejects.toBeInstanceOf(ClassifierUnavailableError);
    }
    expect(logger.error).toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(2);
    expect(vi.mocked(alert).mock.calls[0]?.[0]).toMatchObject({ severity: "P1", title: MODELS_MISSING_ALERT_TITLE, body: expect.stringContaining(dir) });
    // The process-wide instance is the failing one too.
    expect(imageClassifier(env({ APP_ENV: "prod", MEDIA_MODELS_DIR: dir }))).toBeInstanceOf(UnavailableImageClassifier);
  });

  it("reports missing models at worker start outside dev only (error log, P1 alert), present ones silently", async () => {
    const dir = temp();
    expect(await checkModelsAtStartup(env({ MEDIA_MODELS_DIR: dir }))).toBe(true);
    expect(alert).not.toHaveBeenCalled();
    for (const APP_ENV of ["staging", "prod"] as const) expect(await checkModelsAtStartup(env({ APP_ENV, MEDIA_MODELS_DIR: dir }))).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenCalledTimes(2);
    // Same alert as a refused photo: the hour's dedupe sends one.
    expect(vi.mocked(alert).mock.calls[0]?.[0]).toMatchObject({ severity: "P1", title: MODELS_MISSING_ALERT_TITLE, body: expect.stringContaining(dir) });
    vi.mocked(alert).mockClear();
    for (const file of Object.values(MODEL_FILES)) writeFileSync(path.join(dir, file), "");
    expect(await checkModelsAtStartup(env({ APP_ENV: "prod", MEDIA_MODELS_DIR: dir }))).toBe(true);
    expect(alert).not.toHaveBeenCalled();
  });

  it("chooses ONNX when both files exist and shares one instance per process", async () => {
    const dir = temp();
    writeFileSync(path.join(dir, MODEL_FILES.nsfw), "");
    writeFileSync(path.join(dir, MODEL_FILES.face), "");
    const classifier = createImageClassifier(env({ APP_ENV: "prod", MEDIA_MODELS_DIR: dir }), DEFAULT_AI);
    expect(classifier).toBeInstanceOf(OnnxImageClassifier);
    expect((classifier as InstanceType<typeof OnnxImageClassifier>).faceThreshold).toBe(DEFAULT_AI.face.minConfidence);
    expect((classifier as InstanceType<typeof OnnxImageClassifier>).paths).toEqual(modelPaths(dir));
    expect(logger.warn).not.toHaveBeenCalled();
    const shared = imageClassifier(env({ MEDIA_MODELS_DIR: dir }));
    expect(imageClassifier(env({ MEDIA_MODELS_DIR: temp() }))).toBe(shared);
    await resetImageClassifier();
    expect(imageClassifier(env({ MEDIA_MODELS_DIR: temp() }))).not.toBe(shared);
  });
});

// Real models (22 MB + 0.2 MB) are present only where `node scripts/fetch-models.ts` ran.
describe.skipIf(!modelsPresent(repoModels))("OnnxImageClassifier with the real models", () => {
  const classifier = new OnnxImageClassifier(modelPaths(repoModels), DEFAULT_AI.face.minConfidence);
  afterAll(async () => {
    await classifier.close();
  });

  it("scores a flat colour and a gradient as safe for work with no face", async () => {
    const flat = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 120, g: 160, b: 90 } } }).jpeg().toBuffer();
    const gradient = await sharp(Buffer.from(Array.from({ length: 256 * 3 }, (_, i) => Math.floor(i / 3))), { raw: { width: 256, height: 1, channels: 3 } })
      .resize(800, 600, { kernel: "cubic" })
      .webp()
      .toBuffer();
    for (const image of [flat, gradient]) {
      const result = await classifier.classify(image);
      expect(result.nsfw).toBeGreaterThanOrEqual(0);
      expect(result.nsfw).toBeLessThan(0.5);
      expect(result.faces).toBe(0);
    }
    expect(classifier.name).toBe("onnx");
  }, 60_000);
});
