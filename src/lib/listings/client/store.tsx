"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { ApiError } from "@/lib/auth/client";
import type { FieldIssue, ListingPatch, OwnerListing, OwnerPhoto, PublishListingResponse } from "@/lib/contracts/listings";
import type { ListingPhoto, UploadRejectReason } from "@/lib/contracts/media";
import { deleteUpload, patchListing, pollUpload } from "./api";
import { Autosave, type AutosaveState } from "./autosave";
import { photoUrl } from "./photo-url";
import { uploadListingPhoto, uploadErrorCode } from "./upload";

// Client state of the posting wizard: the listing as edited (optimistic), the autosave queue
// (design D2), the photo tiles with their upload progress, the server's publish blockers. The
// server page only resolves id and step; this store hydrates from GET /api/listings/{id}.

export type PhotoItemStatus = "preparing" | "uploading" | "processing" | "ready" | "rejected" | "failed" | "timeout";

export interface PhotoItem {
  /** Stable local key (the upload id once known). */
  key: string;
  uploadId: string | null;
  status: PhotoItemStatus;
  /** Upload progress in [0, 1]. */
  progress: number;
  /** Object URL of the local file, or the `s` variant URL once published. */
  previewUrl: string | null;
  photo: ListingPhoto | null;
  blurhash?: string;
  rejectReason?: UploadRejectReason;
  /** `Listing.errors.<code>` / `Listing.photos.<code>` for a failed upload. */
  errorCode?: string;
  file?: File;
}

interface WizardState {
  listing: OwnerListing;
  saveState: AutosaveState;
  saveError: unknown;
  photos: PhotoItem[];
  blockers: FieldIssue[];
  publishResult: PublishListingResponse | null;
}

type Action =
  | { type: "patch"; patch: ListingPatch }
  | { type: "server"; listing: OwnerListing }
  | { type: "save-state"; state: AutosaveState; error?: unknown }
  | { type: "photo-add"; item: PhotoItem }
  | { type: "photo-update"; key: string; changes: Partial<PhotoItem> }
  | { type: "photo-remove"; key: string }
  | { type: "photo-move"; key: string; to: number }
  | { type: "blockers"; blockers: FieldIssue[] }
  | { type: "published"; result: PublishListingResponse; listing?: Partial<OwnerListing> };

function applyPatch(listing: OwnerListing, patch: ListingPatch): OwnerListing {
  const next: OwnerListing = { ...listing };
  if (patch.categoryId !== undefined) next.categoryId = patch.categoryId;
  if (patch.subcategoryId !== undefined) next.subcategoryId = patch.subcategoryId;
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.attributes !== undefined) next.attributes = patch.attributes;
  if (patch.condition !== undefined) next.condition = patch.condition;
  if (patch.price !== undefined) next.price = patch.price;
  if (patch.priceNegotiable !== undefined) next.priceNegotiable = patch.priceNegotiable;
  if (patch.isDonation !== undefined) next.isDonation = patch.isDonation;
  if (patch.location !== undefined) next.location = patch.location;
  if (patch.contact !== undefined) next.contact = patch.contact;
  if (patch.sensitiveDeclaration !== undefined) {
    next.sensitiveDeclaration = patch.sensitiveDeclaration ? { kind: patch.sensitiveDeclaration.kind, at: new Date().toISOString() } : null;
  }
  return next;
}

function reducer(state: WizardState, action: Action): WizardState {
  switch (action.type) {
    case "patch":
      return { ...state, listing: applyPatch(state.listing, action.patch) };
    case "server": {
      // Only what the server owns: version, dates, status, moderation. Text stays as typed.
      const { version, updatedAt, status, moderation, publishedAt, expiresAt, slugId, pausedReason } = action.listing;
      return { ...state, listing: { ...state.listing, version, updatedAt, status, moderation, publishedAt, expiresAt, slugId, pausedReason } };
    }
    case "save-state":
      return { ...state, saveState: action.state, saveError: action.state === "error" ? action.error : undefined };
    case "photo-add":
      return { ...state, photos: [...state.photos, action.item] };
    case "photo-update":
      return { ...state, photos: state.photos.map((item) => (item.key === action.key ? { ...item, ...action.changes } : item)) };
    case "photo-remove":
      return { ...state, photos: state.photos.filter((item) => item.key !== action.key) };
    case "photo-move": {
      const from = state.photos.findIndex((item) => item.key === action.key);
      if (from === -1) return state;
      const to = Math.max(0, Math.min(state.photos.length - 1, action.to));
      if (from === to) return state;
      const photos = [...state.photos];
      const [moved] = photos.splice(from, 1);
      if (moved) photos.splice(to, 0, moved);
      return { ...state, photos };
    }
    case "blockers":
      return { ...state, blockers: action.blockers };
    case "published":
      return {
        ...state,
        publishResult: action.result,
        blockers: [],
        listing: { ...state.listing, status: action.result.status, slugId: action.result.slugId ?? state.listing.slugId, ...action.listing },
      };
  }
}

/** Tiles from the listing as the server returns it (statuses merged from `uploads`). */
export function photoItemsFromListing(listing: OwnerListing, mediaBaseUrl: string | null): PhotoItem[] {
  return listing.photos.map((photo: OwnerPhoto): PhotoItem => {
    const ready = photo.status === "ready" && photo.w !== undefined && photo.h !== undefined && photo.blurhash !== undefined;
    return {
      key: photo.id,
      uploadId: photo.id,
      status: photo.status === "rejected" ? "rejected" : ready ? "ready" : "processing",
      progress: 1,
      previewUrl: ready ? photoUrl(mediaBaseUrl, listing.id, photo.id, "s") : null,
      photo: ready ? { id: photo.id, w: photo.w!, h: photo.h!, blurhash: photo.blurhash! } : null,
      blurhash: photo.blurhash,
      rejectReason: photo.rejectReason,
    };
  });
}

export function readyPhotoIds(photos: readonly PhotoItem[]): string[] {
  return photos.filter((item) => item.status === "ready" && item.uploadId).map((item) => item.uploadId!);
}

export function isPhotoBusy(item: PhotoItem): boolean {
  return item.status === "preparing" || item.status === "uploading" || item.status === "processing";
}

export interface WizardContextValue extends WizardState {
  listingId: string;
  maxPhotos: number;
  mediaBaseUrl: string | null;
  /** Applies a change locally and queues the autosave; `flush` sends it now (step change, photos). */
  update: (patch: ListingPatch, options?: { flush?: boolean }) => void;
  flush: () => Promise<void>;
  retrySave: () => void;
  addFiles: (files: Iterable<File>) => void;
  removePhoto: (key: string) => void;
  retryPhoto: (key: string) => void;
  refreshPhoto: (key: string) => void;
  movePhoto: (key: string, to: number) => void;
  setBlockers: (blockers: FieldIssue[]) => void;
  setPublished: (result: PublishListingResponse) => void;
  photosBusy: boolean;
}

const WizardContext = createContext<WizardContextValue | null>(null);

/** Uploads at once: resizing is CPU-bound, so two in parallel is plenty on a phone. */
const UPLOAD_CONCURRENCY = 2;

interface UploadRunner {
  enqueue(job: () => Promise<void>): void;
}

/** Small job queue with a concurrency cap; jobs start in order and never throw out of the runner. */
export function createUploadRunner(concurrency: number): UploadRunner {
  const queue: (() => Promise<void>)[] = [];
  let running = 0;
  const pump = () => {
    while (running < concurrency && queue.length > 0) {
      const job = queue.shift()!;
      running += 1;
      void job()
        .catch(() => undefined)
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  };
  return {
    enqueue(job) {
      queue.push(job);
      pump();
    },
  };
}

interface WizardProviderProps {
  listing: OwnerListing;
  maxPhotos: number;
  mediaBaseUrl: string | null;
  children: ReactNode;
  /** Injected in tests. */
  upload?: typeof uploadListingPhoto;
  save?: (id: string, patch: ListingPatch) => Promise<{ listing: OwnerListing }>;
}

export function WizardProvider({ listing, maxPhotos, mediaBaseUrl, children, upload = uploadListingPhoto, save = patchListing }: WizardProviderProps) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    listing,
    saveState: "idle" as AutosaveState,
    saveError: undefined,
    photos: photoItemsFromListing(listing, mediaBaseUrl),
    blockers: [],
    publishResult: null,
  }));
  const listingId = listing.id;
  const autosave = useRef<Autosave<ListingPatch> | null>(null);
  if (autosave.current === null) {
    autosave.current = new Autosave<ListingPatch>({
      save: async (patch) => {
        const answer = await save(listingId, patch);
        dispatch({ type: "server", listing: answer.listing });
      },
      onState: (saveState, error) => dispatch({ type: "save-state", state: saveState, error }),
    });
  }
  const controllers = useRef(new Map<string, AbortController>());
  const runner = useRef<UploadRunner | null>(null);
  runner.current ??= createUploadRunner(UPLOAD_CONCURRENCY);
  const lastSentPhotos = useRef<string>(JSON.stringify(readyPhotoIds(state.photos)));

  useEffect(() => {
    const instance = autosave.current;
    const aborters = controllers.current;
    const onHide = () => void instance?.flush();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      instance?.dispose();
      for (const controller of aborters.values()) controller.abort();
    };
  }, []);

  const update = useCallback((patch: ListingPatch, options: { flush?: boolean } = {}) => {
    dispatch({ type: "patch", patch });
    autosave.current?.queue(patch);
    if (options.flush) void autosave.current?.flush();
  }, []);

  const flush = useCallback(() => autosave.current?.flush() ?? Promise.resolve(), []);
  const retrySave = useCallback(() => void autosave.current?.flush(), []);

  // The ordered list of ready photos is sent whenever it changes (upload done, reorder, removal).
  const readyIds = JSON.stringify(readyPhotoIds(state.photos));
  useEffect(() => {
    if (readyIds === lastSentPhotos.current) return;
    lastSentPhotos.current = readyIds;
    update({ photos: JSON.parse(readyIds) as string[] }, { flush: true });
  }, [readyIds, update]);

  const startUpload = useCallback(
    (key: string, file: File) => {
      const controller = new AbortController();
      controllers.current.set(key, controller);
      runner.current?.enqueue(async () => {
        if (controller.signal.aborted) return;
        try {
          await upload(listingId, file, {
            signal: controller.signal,
            onPhase: (phase) => {
              switch (phase.phase) {
                case "preparing":
                  dispatch({ type: "photo-update", key, changes: { status: "preparing", progress: 0 } });
                  break;
                case "uploading":
                  dispatch({ type: "photo-update", key, changes: { status: "uploading", progress: phase.progress, uploadId: phase.uploadId } });
                  break;
                case "processing":
                  dispatch({ type: "photo-update", key, changes: { status: "processing", progress: 1, uploadId: phase.uploadId } });
                  break;
                case "ready":
                  dispatch({ type: "photo-update", key, changes: { status: "ready", uploadId: phase.uploadId, photo: phase.photo, blurhash: phase.photo.blurhash, file: undefined } });
                  break;
                case "rejected":
                  dispatch({ type: "photo-update", key, changes: { status: "rejected", uploadId: phase.uploadId, rejectReason: phase.reason } });
                  break;
                case "timeout":
                  dispatch({ type: "photo-update", key, changes: { status: "timeout", uploadId: phase.uploadId } });
                  break;
              }
            },
          });
        } catch (error) {
          if (error instanceof ApiError && error.code === "aborted") return;
          dispatch({ type: "photo-update", key, changes: { status: "failed", errorCode: uploadErrorCode(error) } });
        } finally {
          controllers.current.delete(key);
        }
      });
    },
    [listingId, upload],
  );

  const addFiles = useCallback(
    (files: Iterable<File>) => {
      const room = Math.max(0, maxPhotos - state.photos.length);
      for (const file of Array.from(files).slice(0, room)) {
        const key = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const previewUrl = typeof URL !== "undefined" && "createObjectURL" in URL ? URL.createObjectURL(file) : null;
        dispatch({ type: "photo-add", item: { key, uploadId: null, status: "preparing", progress: 0, previewUrl, photo: null, file } });
        startUpload(key, file);
      }
    },
    [maxPhotos, startUpload, state.photos.length],
  );

  const removePhoto = useCallback(
    (key: string) => {
      const item = state.photos.find((photo) => photo.key === key);
      controllers.current.get(key)?.abort();
      if (item?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(item.previewUrl);
      if (item?.uploadId) void deleteUpload(item.uploadId).catch(() => undefined);
      dispatch({ type: "photo-remove", key });
    },
    [state.photos],
  );

  const retryPhoto = useCallback(
    (key: string) => {
      const item = state.photos.find((photo) => photo.key === key);
      if (!item?.file) return;
      dispatch({ type: "photo-update", key, changes: { status: "preparing", progress: 0, errorCode: undefined, rejectReason: undefined, uploadId: null } });
      startUpload(key, item.file);
    },
    [startUpload, state.photos],
  );

  /** One more status check for a photo whose processing outlasted the poll deadline. */
  const refreshPhoto = useCallback(
    (key: string) => {
      const item = state.photos.find((photo) => photo.key === key);
      if (!item?.uploadId) return;
      const uploadId = item.uploadId;
      dispatch({ type: "photo-update", key, changes: { status: "processing" } });
      void pollUpload(uploadId, { intervalMs: 0, maxMs: 1 }).then(
        (status) => {
          if (status.status === "ready") dispatch({ type: "photo-update", key, changes: { status: "ready", photo: status.photo, blurhash: status.photo.blurhash, previewUrl: item.previewUrl ?? photoUrl(mediaBaseUrl, listingId, uploadId, "s") } });
          else if (status.status === "rejected") dispatch({ type: "photo-update", key, changes: { status: "rejected", rejectReason: status.rejectReason } });
          else dispatch({ type: "photo-update", key, changes: { status: "timeout" } });
        },
        () => dispatch({ type: "photo-update", key, changes: { status: "timeout" } }),
      );
    },
    [listingId, mediaBaseUrl, state.photos],
  );

  // Photos still processing when the page loaded (a previous session): poll them.
  const polledOnMount = useRef(false);
  useEffect(() => {
    if (polledOnMount.current) return;
    polledOnMount.current = true;
    for (const item of state.photos) {
      if (item.status !== "processing" || !item.uploadId) continue;
      const uploadId = item.uploadId;
      void pollUpload(uploadId).then(
        (status) => {
          if (status.status === "ready") dispatch({ type: "photo-update", key: item.key, changes: { status: "ready", photo: status.photo, blurhash: status.photo.blurhash, previewUrl: photoUrl(mediaBaseUrl, listingId, uploadId, "s") } });
          else if (status.status === "rejected") dispatch({ type: "photo-update", key: item.key, changes: { status: "rejected", rejectReason: status.rejectReason } });
          else dispatch({ type: "photo-update", key: item.key, changes: { status: "timeout" } });
        },
        () => dispatch({ type: "photo-update", key: item.key, changes: { status: "timeout" } }),
      );
    }
  }, [listingId, mediaBaseUrl, state.photos]);

  const movePhoto = useCallback((key: string, to: number) => dispatch({ type: "photo-move", key, to }), []);
  const setBlockers = useCallback((blockers: FieldIssue[]) => dispatch({ type: "blockers", blockers }), []);
  const setPublished = useCallback((result: PublishListingResponse) => dispatch({ type: "published", result }), []);

  const value = useMemo<WizardContextValue>(
    () => ({
      ...state,
      listingId,
      maxPhotos,
      mediaBaseUrl,
      update,
      flush,
      retrySave,
      addFiles,
      removePhoto,
      retryPhoto,
      refreshPhoto,
      movePhoto,
      setBlockers,
      setPublished,
      photosBusy: state.photos.some(isPhotoBusy),
    }),
    [state, listingId, maxPhotos, mediaBaseUrl, update, flush, retrySave, addFiles, removePhoto, retryPhoto, refreshPhoto, movePhoto, setBlockers, setPublished],
  );

  return <WizardContext.Provider value={value}>{children}</WizardContext.Provider>;
}

export function useWizard(): WizardContextValue {
  const value = useContext(WizardContext);
  if (!value) throw new Error("useWizard outside WizardProvider");
  return value;
}
