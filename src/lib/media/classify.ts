import "server-only";
import { existsSync } from "node:fs";
import path from "node:path";
import type * as Ort from "onnxruntime-node";
import { DEFAULT_AI, type AiConfig } from "@/config/ai";
import { alert } from "@/lib/alert";
import type { ServerEnv } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import { openImage } from "./sharp-setup";

// Local image checks of the worker (architecture §3 step 5, design D7): a nudity probability and a
// face count from two ONNX models (models/MANIFEST.json, docs/models.md) run on the CPU with
// onnxruntime-node, one intra-op thread, sessions created lazily once per process. Without the
// model files, dev (and the tests) use the stub, which answers "clean" and whose zeros are never
// stored as checks. A deployed process fails closed: every classification throws (an
// infrastructure failure: the media job retries, then the upload ends rejected and the wizard
// offers a retry) and an alert goes out, so no photo is ever ready without both checks.

export interface ImageClassification {
  /** P(NSFW) in [0, 1]. */
  nsfw: number;
  /** Faces detected with confidence >= the configured threshold. */
  faces: number;
}

export interface ImageClassifier {
  readonly name: string;
  classify(image: Buffer): Promise<ImageClassification>;
  /** Releases native sessions; optional for stateless implementations. */
  close?(): Promise<void>;
}

export const MODEL_FILES = { nsfw: "nsfw-marqo-384.onnx", face: "yunet-2023mar.onnx" } as const;
export type ModelName = keyof typeof MODEL_FILES;
export type ModelPaths = Record<ModelName, string>;
/** Relative to the working directory when MEDIA_MODELS_DIR is unset (the Docker worker sets /app/models). */
export const DEFAULT_MODELS_DIR = "models";

export const NSFW_INPUT_SIZE = 384;
export const FACE_INPUT_SIZE = 640;
const FACE_STRIDES = [8, 16, 32] as const;
const FACE_NMS_IOU = 0.3;

export function modelsDir(env: Pick<ServerEnv, "MEDIA_MODELS_DIR">): string {
  // turbopackIgnore: runtime paths; without it the web trace copies the whole project (models are worker-only).
  return path.resolve(/*turbopackIgnore: true*/ env.MEDIA_MODELS_DIR ?? DEFAULT_MODELS_DIR);
}

export function modelPaths(dir: string): ModelPaths {
  return { nsfw: path.join(/*turbopackIgnore: true*/ dir, MODEL_FILES.nsfw), face: path.join(/*turbopackIgnore: true*/ dir, MODEL_FILES.face) };
}

/** Both model files exist (content is checked by scripts/fetch-models.ts --check, not here). */
export function modelsPresent(dir: string): boolean {
  const paths = modelPaths(dir);
  return existsSync(/*turbopackIgnore: true*/ paths.nsfw) && existsSync(/*turbopackIgnore: true*/ paths.face);
}

type OrtModule = typeof Ort;

const SESSION_OPTIONS: Ort.InferenceSession.SessionOptions = {
  executionProviders: ["cpu"],
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  graphOptimizationLevel: "all",
  enableCpuMemArena: false,
  enableMemPattern: false,
  // 3 = error: ORT otherwise prints a warning per initializer on stderr.
  logSeverityLevel: 3,
};

/** A detected face: score and box normalised to the squashed square input ([0, 1]). */
export interface FaceBox {
  score: number;
  box: [number, number, number, number];
}

function iou(a: FaceBox["box"], b: FaceBox["box"]): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Greedy non-maximum suppression, highest score first. */
export function nonMaximumSuppression(candidates: FaceBox[], threshold = FACE_NMS_IOU): FaceBox[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept: FaceBox[] = [];
  for (const candidate of sorted) if (kept.every((face) => iou(face.box, candidate.box) < threshold)) kept.push(candidate);
  return kept;
}

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

/**
 * YuNet 2023mar outputs (cls_s, obj_s, bbox_s for strides 8/16/32, no anchors) -> faces above
 * `threshold`, as OpenCV's FaceDetectorYN decodes them. Exported for tests with synthetic tensors.
 */
export function decodeYunet(outputs: Record<string, { data: Ort.Tensor.DataType }>, threshold: number, inputSize = FACE_INPUT_SIZE): FaceBox[] {
  const candidates: FaceBox[] = [];
  for (const stride of FACE_STRIDES) {
    const cols = inputSize / stride;
    const cls = outputs[`cls_${stride}`]?.data as Float32Array | undefined;
    const obj = outputs[`obj_${stride}`]?.data as Float32Array | undefined;
    const bbox = outputs[`bbox_${stride}`]?.data as Float32Array | undefined;
    if (!cls || !obj || !bbox) throw new Error(`face model: missing outputs for stride ${stride}`);
    for (let i = 0; i < cols * cols; i++) {
      const score = Math.sqrt(clamp01(cls[i] ?? 0) * clamp01(obj[i] ?? 0));
      if (score < threshold) continue;
      const row = Math.floor(i / cols);
      const col = i % cols;
      const cx = (col + (bbox[i * 4] ?? 0)) * stride;
      const cy = (row + (bbox[i * 4 + 1] ?? 0)) * stride;
      const w = Math.exp(bbox[i * 4 + 2] ?? 0) * stride;
      const h = Math.exp(bbox[i * 4 + 3] ?? 0) * stride;
      candidates.push({ score, box: [(cx - w / 2) / inputSize, (cy - h / 2) / inputSize, (cx + w / 2) / inputSize, (cy + h / 2) / inputSize] });
    }
  }
  return nonMaximumSuppression(candidates);
}

/** P(index 0) of two logits, numerically stable. */
export function softmax2(logits: ArrayLike<number>): number {
  const a = logits[0] ?? 0;
  const b = logits[1] ?? 0;
  const m = Math.max(a, b);
  const ea = Math.exp(a - m);
  const eb = Math.exp(b - m);
  return ea / (ea + eb);
}

export class OnnxImageClassifier implements ImageClassifier {
  readonly name = "onnx";
  private runtime: Promise<OrtModule> | undefined;
  private readonly sessions: Partial<Record<ModelName, Promise<Ort.InferenceSession>>> = {};

  constructor(
    readonly paths: ModelPaths,
    /** Faces below this confidence are not counted (config/ai `face.minConfidence`). */
    readonly faceThreshold: number,
  ) {}

  private ort(): Promise<OrtModule> {
    this.runtime ??= import("onnxruntime-node");
    return this.runtime;
  }

  private session(model: ModelName): Promise<Ort.InferenceSession> {
    this.sessions[model] ??= this.ort().then((ort) => ort.InferenceSession.create(this.paths[model], SESSION_OPTIONS));
    return this.sessions[model];
  }

  /** Both checks on the same decoded image, one after the other (one image at a time, §2). */
  async classify(image: Buffer): Promise<ImageClassification> {
    const nsfw = await this.nsfwScore(image);
    const faces = (await this.detectFaces(image)).length;
    return { nsfw, faces };
  }

  /** Marqo ViT-tiny 384: RGB squashed, (x/255 - 0.5)/0.5, logits [NSFW, SFW]. */
  async nsfwScore(image: Buffer): Promise<number> {
    const size = NSFW_INPUT_SIZE;
    const { data } = await openImage(image)
      .rotate()
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .resize(size, size, { fit: "fill", kernel: "lanczos3" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const n = size * size;
    const tensor = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      tensor[i] = (data[i * 3] ?? 0) / 127.5 - 1;
      tensor[n + i] = (data[i * 3 + 1] ?? 0) / 127.5 - 1;
      tensor[2 * n + i] = (data[i * 3 + 2] ?? 0) / 127.5 - 1;
    }
    const [ort, session] = await Promise.all([this.ort(), this.session("nsfw")]);
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    if (!inputName || !outputName) throw new Error("nsfw model: no input or output");
    const outputs = await session.run({ [inputName]: new ort.Tensor("float32", tensor, [1, 3, size, size]) });
    const logits = outputs[outputName]?.data;
    if (!logits || logits.length < 2) throw new Error("nsfw model: unexpected output");
    return softmax2(logits as Float32Array);
  }

  /** YuNet 2023mar: BGR 0-255 squashed to 640x640, strides 8/16/32, NMS, confidence >= threshold. */
  async detectFaces(image: Buffer): Promise<FaceBox[]> {
    const size = FACE_INPUT_SIZE;
    const { data } = await openImage(image)
      .rotate()
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .resize(size, size, { fit: "fill", kernel: "lanczos3" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const n = size * size;
    const tensor = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      tensor[i] = data[i * 3 + 2] ?? 0;
      tensor[n + i] = data[i * 3 + 1] ?? 0;
      tensor[2 * n + i] = data[i * 3] ?? 0;
    }
    const [ort, session] = await Promise.all([this.ort(), this.session("face")]);
    const inputName = session.inputNames[0];
    if (!inputName) throw new Error("face model: no input");
    const outputs = await session.run({ [inputName]: new ort.Tensor("float32", tensor, [1, 3, size, size]) });
    return decodeYunet(outputs, this.faceThreshold, size);
  }

  async close(): Promise<void> {
    const pending = Object.values(this.sessions);
    for (const key of Object.keys(this.sessions) as ModelName[]) delete this.sessions[key];
    await Promise.allSettled(pending.map(async (session) => (await session).release()));
  }
}

/** Fixed or computed answers for tests and for environments without the model files. */
export class StubImageClassifier implements ImageClassifier {
  readonly name = "stub";
  calls = 0;

  constructor(private readonly results: ImageClassification | ((image: Buffer) => ImageClassification) = { nsfw: 0, faces: 0 }) {}

  async classify(image: Buffer): Promise<ImageClassification> {
    this.calls += 1;
    return typeof this.results === "function" ? this.results(image) : { ...this.results };
  }
}

/** The local checks cannot run (model files missing in a deployed process): not a media error, retried. */
export class ClassifierUnavailableError extends Error {
  constructor(message = "photo checks unavailable: ONNX model files missing") {
    super(message);
    this.name = "ClassifierUnavailableError";
  }
}

/** Title of the alert raised while deployed photo checks cannot run (alert() sends it at most once an hour). */
export const MODELS_MISSING_ALERT_TITLE = "Contrôle des photos indisponible : modèles ONNX absents";

/** Deployed without the model files: refuses every photo instead of letting it through unchecked. */
export class UnavailableImageClassifier implements ImageClassifier {
  readonly name = "unavailable";

  constructor(
    readonly modelsDir: string,
    readonly appEnv: string,
  ) {}

  async classify(): Promise<ImageClassification> {
    logger.error({ modelsDir: this.modelsDir }, "ONNX models missing: photo refused for processing (fail closed)");
    await alert({
      severity: "P1",
      title: MODELS_MISSING_ALERT_TITLE,
      body: `Les fichiers ${MODEL_FILES.nsfw} et ${MODEL_FILES.face} sont introuvables dans ${this.modelsDir} (${this.appEnv}) : aucune photo ne passe à l'état prêt, les envois finissent refusés après les nouvelles tentatives. Lancer node scripts/fetch-models.ts --check dans l'image du worker, puis redéployer.`,
    });
    throw new ClassifierUnavailableError();
  }
}

/**
 * ONNX when both model files exist under MEDIA_MODELS_DIR; otherwise the stub in dev, and outside
 * dev a classifier that fails closed (every call throws and alerts).
 */
export function createImageClassifier(env: Pick<ServerEnv, "APP_ENV" | "MEDIA_MODELS_DIR">, ai: AiConfig): ImageClassifier {
  const dir = modelsDir(env);
  if (modelsPresent(dir)) return new OnnxImageClassifier(modelPaths(dir), ai.face.minConfidence);
  if (env.APP_ENV === "dev") return new StubImageClassifier();
  logger.error({ modelsDir: dir }, "ONNX models missing: photo checks fail closed");
  return new UnavailableImageClassifier(dir, env.APP_ENV);
}

let shared: ImageClassifier | undefined;

/** The process-wide classifier (sessions are expensive); the thresholds of the first call apply. */
export function imageClassifier(env: Pick<ServerEnv, "APP_ENV" | "MEDIA_MODELS_DIR">, ai: AiConfig = DEFAULT_AI): ImageClassifier {
  shared ??= createImageClassifier(env, ai);
  return shared;
}

/** Tests, and the worker's shutdown: release the shared sessions. */
export async function resetImageClassifier(): Promise<void> {
  const current = shared;
  shared = undefined;
  await current?.close?.();
}
