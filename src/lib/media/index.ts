import "server-only";

// Photo primitives of phase 3 (design §4 "src/lib/media/"): sniffing, the sharp pipeline, hashes,
// local ONNX checks and object keys. pipeline.ts and queue.ts (another lot) compose them.

export { isMediaError, MediaError } from "./errors";
export { ACCEPTED_IMAGE_TYPES, checkImageType, isAcceptedImageType, SNIFF_BYTES, sniffImageType } from "./magic";
export type { AcceptedImageType, SniffedImageType } from "./magic";
export { processImage, toMediaError } from "./process";
export type { ProcessedImage } from "./process";
export { dhash, dhashFromGrey, hammingDistance, isImageHash } from "./phash";
export {
  createImageClassifier,
  DEFAULT_MODELS_DIR,
  imageClassifier,
  MODEL_FILES,
  modelPaths,
  modelsDir,
  modelsPresent,
  OnnxImageClassifier,
  resetImageClassifier,
  StubImageClassifier,
} from "./classify";
export type { FaceBox, ImageClassification, ImageClassifier, ModelName, ModelPaths } from "./classify";
export { listingMediaPrefix, MEDIA_CACHE_CONTROL, MEDIA_CONTENT_TYPE, mediaObjectKey, photoUrl, quarantineObjectKey } from "./urls";
export { MAX_INPUT_PIXELS, PIPELINE_TIMEOUT_SECONDS } from "./sharp-setup";
