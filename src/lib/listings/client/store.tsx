"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { ApiError, isApiError } from "@/lib/auth/client";
import type { FieldIssue, ListingPatch, ListingStatus, OwnerListing, OwnerPhoto, PublishListingResponse } from "@/lib/contracts/listings";
import type { ListingPhoto, UploadRejectReason } from "@/lib/contracts/media";
import { deleteUpload, getUpload, patchListing, patchListingOnUnload, pollUpload } from "./api";
import { Autosave, type AutosaveState } from "./autosave";
import { photoUrl } from "./photo-url";
import { LEAVE_REASON, uploadListingPhoto, uploadErrorCode } from "./upload";
import { sanitizePatch, withoutRejectedFields } from "./validation";

// Client state of the posting wizard: the listing as edited (optimistic), the autosave queue
// (design D2), the photo tiles with their upload progress, the server's blockers. The server page
// only resolves id and step; this store hydrates from GET /api/listings/{id}. A draft saves itself
// (coalesced); a live listing keeps its changes until "Enregistrer" (each write re-screens it).

export type PhotoItemStatus = "preparing" | "uploading" | "processing" | "ready" | "rejected" | "failed" | "timeout";

export interface PhotoItem {
  /** Stable local key (the upload id for photos loaded from the server). */
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
  /** `Listing.errors.<code>` / `Listing.photos.<code>` for a failed upload or removal. */
  errorCode?: string;
  /** DELETE /api/uploads/{id} in flight. */
  removing?: boolean;
  file?: File;
}

export type SaveMode = "auto" | "manual";

/** Drafts save themselves (a rejected listing becomes a draft again with its first save); live listings save on request. */
export function saveModeOf(status: ListingStatus): SaveMode {
  return status === "draft" || status === "rejected" ? "auto" : "manual";
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
  | { type: "published"; result: PublishListingResponse };

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

/** Field groups of a blocker path: editing any field of the group clears the blocker. */
function blockerGroup(path: string): string {
  const head = path.split(".")[0] ?? "";
  if (head === "price" || head === "isDonation" || head === "priceNegotiable") return "price";
  if (head === "categoryId" || head === "subcategoryId") return "category";
  return head;
}

/** Blockers still standing after `patch`: the ones about an edited field are the person's to re-check. */
export function blockersAfterPatch(blockers: readonly FieldIssue[], patch: ListingPatch): FieldIssue[] {
  const edited = new Set(Object.keys(patch).map(blockerGroup));
  return blockers.filter((issue) => !edited.has(blockerGroup(issue.path)));
}

function reducer(state: WizardState, action: Action): WizardState {
  switch (action.type) {
    case "patch": {
      const blockers = state.blockers.length > 0 ? blockersAfterPatch(state.blockers, action.patch) : state.blockers;
      return {
        ...state,
        listing: applyPatch(state.listing, action.patch),
        blockers,
      };
    }
    case "server": {
      // Only what the server owns: version, dates, status, moderation. Text stays as typed.
      const { version, updatedAt, status, moderation, publishedAt, expiresAt, slugId, pausedReason } = action.listing;
      return {
        ...state,
        listing: {
          ...state.listing,
          version,
          updatedAt,
          status,
          moderation,
          publishedAt,
          expiresAt,
          slugId,
          pausedReason,
        },
      };
    }
    case "save-state":
      return {
        ...state,
        saveState: action.state,
        saveError: action.state === "error" ? action.error : undefined,
      };
    case "photo-add":
      return { ...state, photos: [...state.photos, action.item] };
    case "photo-update":
      return {
        ...state,
        photos: state.photos.map((item) => (item.key === action.key ? { ...item, ...action.changes } : item)),
      };
    case "photo-remove":
      return {
        ...state,
        photos: state.photos.filter((item) => item.key !== action.key),
      };
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
        listing: {
          ...state.listing,
          status: action.result.status,
          slugId: action.result.slugId ?? state.listing.slugId,
        },
      };
  }
}

/** Tiles from the listing as the server returns it (statuses merged from `uploads`). */
export function photoItemsFromListing(listing: OwnerListing, mediaBaseUrl: string | null): PhotoItem[] {
  return (
    listing.photos
      // `signed`: an upload abandoned before its PUT (tab closed); the server purges it, nothing to show.
      .filter((photo) => photo.status !== "signed")
      .map((photo: OwnerPhoto): PhotoItem => {
        const ready = photo.status === "ready" && photo.w !== undefined && photo.h !== undefined && photo.blurhash !== undefined;
        return {
          key: photo.id,
          uploadId: photo.id,
          status: photo.status === "rejected" ? "rejected" : ready ? "ready" : "processing",
          progress: 1,
          previewUrl: ready ? photoUrl(mediaBaseUrl, listing.id, photo.id, "s") : null,
          photo: ready
            ? {
                id: photo.id,
                w: photo.w!,
                h: photo.h!,
                blurhash: photo.blurhash!,
              }
            : null,
          blurhash: photo.blurhash,
          rejectReason: photo.rejectReason,
        };
      })
  );
}

/** The listing's photos as the tiles stand (what readiness checks and the review step count). */
export function ownerPhotosOf(items: readonly PhotoItem[]): OwnerPhoto[] {
  const photos: OwnerPhoto[] = [];
  for (const item of items) {
    if (!item.uploadId) continue;
    if (item.status === "ready" && item.photo)
      photos.push({
        id: item.uploadId,
        status: "ready",
        w: item.photo.w,
        h: item.photo.h,
        blurhash: item.photo.blurhash,
      });
    else if (item.status === "rejected")
      photos.push({
        id: item.uploadId,
        status: "rejected",
        ...(item.rejectReason ? { rejectReason: item.rejectReason } : {}),
      });
    else if (item.status === "processing" || item.status === "timeout") photos.push({ id: item.uploadId, status: "processing" });
  }
  return photos;
}

export function readyPhotoIds(photos: readonly PhotoItem[]): string[] {
  return photos.filter((item) => item.status === "ready" && item.uploadId).map((item) => item.uploadId!);
}

/**
 * The order sent as `photos`: ready photos and those still processing (the pipeline may attach one
 * before the browser hears about it; the server keeps attached ids and skips the others).
 */
export function photoOrder(photos: readonly PhotoItem[]): string[] {
  return photos.filter((item) => item.uploadId && (item.status === "ready" || item.status === "processing" || item.status === "timeout")).map((item) => item.uploadId!);
}

export function isPhotoBusy(item: PhotoItem): boolean {
  return item.status === "preparing" || item.status === "uploading" || item.status === "processing";
}

/** Blockers of a 422 `invalid_listing`: `details` is the FieldIssue list, or `{ blockers }`. */
export function blockersOf(error: ApiError): FieldIssue[] {
  const details = error.details as unknown;
  const list = Array.isArray(details)
    ? details
    : details && typeof details === "object" && Array.isArray((details as { blockers?: unknown }).blockers)
      ? (details as { blockers: unknown[] }).blockers
      : [];
  return list.filter((item): item is FieldIssue => Boolean(item) && typeof (item as FieldIssue).path === "string" && typeof (item as FieldIssue).code === "string");
}

const backoff = (attempt: number) => Math.min(120_000, 15_000 * 2 ** Math.max(0, attempt - 1));

/** Automatic retry after a failed save (Autosave `retryAfter`); null waits for "Réessayer". */
export function saveRetryDelay(error: unknown, attempt: number): number | null {
  if (!(error instanceof ApiError)) return backoff(attempt);
  if (error.code === "network" || error.code === "unavailable" || error.code === "internal" || error.status >= 500) return backoff(attempt);
  if (error.code === "rate_limited") return Math.min(10 * 60_000, Math.max(1, error.retryAfter ?? 60) * 1000);
  // Version race with the photo pipeline (it bumps `version` when it attaches a photo): once, quickly.
  if (error.code === "conflict") return attempt <= 1 ? 400 : null;
  // The refused fields were dropped by `recoverPatch`: send the rest.
  if (error.code === "invalid_body") return 0;
  return null;
}

/** What a failed save keeps for the next attempt (Autosave `recover`). */
export function recoverPatch(patch: ListingPatch, error: unknown): ListingPatch | null {
  if (isApiError(error, "invalid_body")) return withoutRejectedFields(patch, error.details);
  if (isApiError(error, "not_found")) return null;
  return patch;
}

export interface WizardContextValue extends WizardState {
  listingId: string;
  maxPhotos: number;
  mediaBaseUrl: string | null;
  saveMode: SaveMode;
  /** Applies a change locally and queues it; `flush` sends it now (a draft only). */
  update: (patch: ListingPatch, options?: { flush?: boolean }) => void;
  /** Draft: sends what is pending (step change, blur). Live listing: does nothing. */
  flush: () => Promise<boolean>;
  /** Sends what is pending whatever the mode; `reopen` also commits an empty patch (rejected -> draft). Resolves true when saved. */
  save: (options?: { reopen?: boolean }) => Promise<boolean>;
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
  /** A live listing left inside the app with unsaved changes: they are handed over (to offer saving them). */
  onUnsavedLeave?: (patch: ListingPatch) => void;
  /** Injected in tests. */
  upload?: typeof uploadListingPhoto;
  save?: (id: string, patch: ListingPatch) => Promise<{ listing: OwnerListing }>;
}

function revokePreview(item: PhotoItem | undefined): void {
  if (item?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(item.previewUrl);
}

export function WizardProvider({ listing, maxPhotos, mediaBaseUrl, children, onUnsavedLeave, upload = uploadListingPhoto, save = patchListing }: WizardProviderProps) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    listing,
    saveState: "idle" as AutosaveState,
    saveError: undefined,
    photos: photoItemsFromListing(listing, mediaBaseUrl),
    blockers: [],
    publishResult: null,
  }));
  const listingId = listing.id;
  const saveMode = saveModeOf(state.listing.status);
  const [autosave] = useState(() => {
    const instance: Autosave<ListingPatch> = new Autosave<ListingPatch>({
      manual: saveModeOf(listing.status) === "manual",
      save: async (patch) => {
        try {
          const answer = await save(listingId, patch);
          dispatch({ type: "server", listing: answer.listing });
          // A live listing passed the re-check: its earlier refusals are settled.
          if (instance.isManual) dispatch({ type: "blockers", blockers: [] });
        } catch (error) {
          if (isApiError(error, "invalid_listing")) dispatch({ type: "blockers", blockers: blockersOf(error) });
          throw error;
        }
      },
      recover: recoverPatch,
      retryAfter: saveRetryDelay,
      onState: (saveState, error) => dispatch({ type: "save-state", state: saveState, error }),
    });
    return instance;
  });
  const [controllers] = useState(() => new Map<string, AbortController>());
  const [runner] = useState(() => createUploadRunner(UPLOAD_CONCURRENCY));
  const polls = useRef<AbortController | null>(null);
  const photosRef = useRef(state.photos);
  const onLeaveRef = useRef(onUnsavedLeave);
  const lastSentReady = useRef<string>(readyPhotoIds(state.photos).join(","));

  useEffect(() => {
    photosRef.current = state.photos;
  }, [state.photos]);

  useEffect(() => {
    onLeaveRef.current = onUnsavedLeave;
  }, [onUnsavedLeave]);

  useEffect(() => {
    autosave.setManual(saveMode === "manual");
  }, [autosave, saveMode]);

  useEffect(() => {
    const instance = autosave;
    instance.revive();
    const pollsController = new AbortController();
    polls.current = pollsController;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void instance.flush();
    };
    // The page is going away: a keepalive request carries the last changes of a draft.
    const onHide = () => {
      if (instance.isManual) return;
      const pending = instance.takePending();
      if (pending) patchListingOnUnload(listingId, pending);
    };
    // A live listing with unsaved changes: the browser asks before leaving.
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (instance.isManual && instance.hasPending()) event.preventDefault();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      // Leaving the wizard inside the app (header link): a draft keeps what was typed; a live
      // listing's changes are handed to the page, which offers to save them.
      if (instance.isManual) {
        const pending = instance.takePending();
        if (pending && Object.keys(pending).length > 0) onLeaveRef.current?.(pending);
      } else void instance.flush();
      instance.dispose();
      // Uploads still being sent are dropped; completed ones finish server side (attached by the pipeline).
      for (const controller of controllers.values()) controller.abort(LEAVE_REASON);
      pollsController.abort();
    };
  }, [autosave, controllers, listingId]);

  useEffect(
    () => () => {
      for (const item of photosRef.current) revokePreview(item);
    },
    [],
  );

  const update = useCallback(
    (patch: ListingPatch, options: { flush?: boolean } = {}) => {
      dispatch({ type: "patch", patch });
      // Half-typed values stay on screen but are not sent (the API would refuse the whole patch).
      const payload = sanitizePatch(patch);
      if (Object.keys(payload).length > 0) autosave.queue(payload);
      if (options.flush) void autosave.flush();
    },
    [autosave],
  );

  const flush = useCallback(() => autosave.flush(), [autosave]);
  const saveNow = useCallback(
    (options: { reopen?: boolean } = {}) => {
      if (options.reopen && !autosave.hasPending()) autosave.queue({});
      return autosave.flush({ force: true });
    },
    [autosave],
  );
  const retrySave = useCallback(() => void autosave.flush({ force: true }), [autosave]);

  // The photo order is sent whenever the ready set or its order changes (upload done, reorder).
  const readyKey = readyPhotoIds(state.photos).join(",");
  useEffect(() => {
    if (readyKey === lastSentReady.current) return;
    lastSentReady.current = readyKey;
    update({ photos: photoOrder(photosRef.current) }, { flush: true });
  }, [readyKey, update]);

  const settle = useCallback(
    (key: string, uploadId: string, status: Awaited<ReturnType<typeof getUpload>>, previewUrl: string | null) => {
      if (status.status === "ready")
        dispatch({
          type: "photo-update",
          key,
          changes: {
            status: "ready",
            photo: status.photo,
            blurhash: status.photo.blurhash,
            previewUrl: previewUrl ?? photoUrl(mediaBaseUrl, listingId, uploadId, "s"),
          },
        });
      else if (status.status === "rejected")
        dispatch({
          type: "photo-update",
          key,
          changes: { status: "rejected", rejectReason: status.rejectReason },
        });
      else dispatch({ type: "photo-update", key, changes: { status: "timeout" } });
    },
    [listingId, mediaBaseUrl],
  );

  const startUpload = useCallback(
    (key: string, file: File) => {
      const controller = new AbortController();
      controllers.set(key, controller);
      runner.enqueue(async () => {
        if (controller.signal.aborted) return;
        try {
          await upload(listingId, file, {
            signal: controller.signal,
            onPhase: (phase) => {
              switch (phase.phase) {
                case "preparing":
                  dispatch({
                    type: "photo-update",
                    key,
                    changes: { status: "preparing", progress: 0 },
                  });
                  break;
                case "uploading":
                  dispatch({
                    type: "photo-update",
                    key,
                    changes: {
                      status: "uploading",
                      progress: phase.progress,
                      uploadId: phase.uploadId,
                    },
                  });
                  break;
                case "processing":
                  dispatch({
                    type: "photo-update",
                    key,
                    changes: {
                      status: "processing",
                      progress: 1,
                      uploadId: phase.uploadId,
                    },
                  });
                  break;
                case "ready":
                  dispatch({
                    type: "photo-update",
                    key,
                    changes: {
                      status: "ready",
                      uploadId: phase.uploadId,
                      photo: phase.photo,
                      blurhash: phase.photo.blurhash,
                      file: undefined,
                    },
                  });
                  break;
                case "rejected":
                  dispatch({
                    type: "photo-update",
                    key,
                    changes: {
                      status: "rejected",
                      uploadId: phase.uploadId,
                      rejectReason: phase.reason,
                    },
                  });
                  break;
                case "timeout":
                  dispatch({
                    type: "photo-update",
                    key,
                    changes: { status: "timeout", uploadId: phase.uploadId },
                  });
                  break;
              }
            },
          });
        } catch (error) {
          if (controller.signal.aborted || isApiError(error, "aborted")) return;
          dispatch({
            type: "photo-update",
            key,
            changes: { status: "failed", errorCode: uploadErrorCode(error) },
          });
        } finally {
          controllers.delete(key);
        }
      });
    },
    [controllers, listingId, runner, upload],
  );

  const addFiles = useCallback(
    (files: Iterable<File>) => {
      const room = Math.max(0, maxPhotos - photosRef.current.length);
      for (const file of Array.from(files).slice(0, room)) {
        const key = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const previewUrl = typeof URL !== "undefined" && "createObjectURL" in URL ? URL.createObjectURL(file) : null;
        const item: PhotoItem = {
          key,
          uploadId: null,
          status: "preparing",
          progress: 0,
          previewUrl,
          photo: null,
          file,
        };
        // Keeps the room right when the picker fires twice before React re-renders.
        photosRef.current = [...photosRef.current, item];
        dispatch({ type: "photo-add", item });
        startUpload(key, file);
      }
    },
    [maxPhotos, startUpload],
  );

  const removePhoto = useCallback(
    (key: string) => {
      const items = photosRef.current;
      const item = items.find((photo) => photo.key === key);
      if (!item || item.removing) return;
      const drop = () => {
        revokePreview(item);
        dispatch({ type: "photo-remove", key });
      };
      if (isPhotoBusy(item) || !item.uploadId) {
        const controller = controllers.get(key);
        // An upload in flight is cancelled; once signed, upload.ts deletes its record itself.
        if (controller) controller.abort();
        // Processing without an upload of this visit (restored or refreshed): its record goes too,
        // or the pipeline would attach it after all.
        else if (item.uploadId) void deleteUpload(item.uploadId).catch(() => undefined);
        drop();
        return;
      }
      // DELETE detaches the photo server side: no order PATCH is needed for its disappearance.
      lastSentReady.current = readyPhotoIds(items.filter((photo) => photo.key !== key)).join(",");
      dispatch({
        type: "photo-update",
        key,
        changes: { removing: true, errorCode: undefined },
      });
      deleteUpload(item.uploadId).then(drop, (error: unknown) => {
        if (isApiError(error, "not_found")) {
          drop();
          return;
        }
        lastSentReady.current = readyPhotoIds(photosRef.current).join(",");
        dispatch({
          type: "photo-update",
          key,
          changes: {
            removing: false,
            errorCode: isApiError(error, "invalid_listing") ? "photos_required" : "remove_failed",
          },
        });
      });
    },
    [controllers],
  );

  const retryPhoto = useCallback(
    (key: string) => {
      const item = photosRef.current.find((photo) => photo.key === key);
      if (!item?.file) return;
      // The refused or half-done upload goes: a new one is signed.
      if (item.uploadId) void deleteUpload(item.uploadId).catch(() => undefined);
      dispatch({
        type: "photo-update",
        key,
        changes: {
          status: "preparing",
          progress: 0,
          errorCode: undefined,
          rejectReason: undefined,
          uploadId: null,
        },
      });
      startUpload(key, item.file);
    },
    [startUpload],
  );

  /** A photo whose processing outlasted the poll deadline: ask again, then keep polling. */
  const refreshPhoto = useCallback(
    (key: string) => {
      const item = photosRef.current.find((photo) => photo.key === key);
      if (!item?.uploadId) return;
      const uploadId = item.uploadId;
      const signal = polls.current?.signal;
      dispatch({
        type: "photo-update",
        key,
        changes: { status: "processing" },
      });
      void getUpload(uploadId)
        .then((status) => (status.status === "processing" ? pollUpload(uploadId, { signal }) : status))
        .then(
          (status) => settle(key, uploadId, status, item.previewUrl),
          () => {
            if (!signal?.aborted)
              dispatch({
                type: "photo-update",
                key,
                changes: { status: "timeout" },
              });
          },
        );
    },
    [settle],
  );

  // Photos still processing when the page loaded (a previous visit): poll them.
  useEffect(() => {
    const controller = new AbortController();
    for (const item of photosRef.current) {
      if (item.status !== "processing" || !item.uploadId) continue;
      const uploadId = item.uploadId;
      void pollUpload(uploadId, { signal: controller.signal }).then(
        (status) => settle(item.key, uploadId, status, null),
        () => {
          if (!controller.signal.aborted)
            dispatch({
              type: "photo-update",
              key: item.key,
              changes: { status: "timeout" },
            });
        },
      );
    }
    return () => controller.abort();
  }, [settle]);

  const movePhoto = useCallback((key: string, to: number) => dispatch({ type: "photo-move", key, to }), []);
  const setBlockers = useCallback((blockers: FieldIssue[]) => dispatch({ type: "blockers", blockers }), []);
  const setPublished = useCallback((result: PublishListingResponse) => dispatch({ type: "published", result }), []);

  const ownerPhotos = useMemo(() => ownerPhotosOf(state.photos), [state.photos]);
  const listingView = useMemo(() => ({ ...state.listing, photos: ownerPhotos }), [state.listing, ownerPhotos]);
  const photosBusy = state.photos.some(isPhotoBusy);

  const value = useMemo<WizardContextValue>(
    () => ({
      ...state,
      listing: listingView,
      listingId,
      maxPhotos,
      mediaBaseUrl,
      saveMode,
      update,
      flush,
      save: saveNow,
      retrySave,
      addFiles,
      removePhoto,
      retryPhoto,
      refreshPhoto,
      movePhoto,
      setBlockers,
      setPublished,
      photosBusy,
    }),
    [
      state,
      listingView,
      listingId,
      maxPhotos,
      mediaBaseUrl,
      saveMode,
      update,
      flush,
      saveNow,
      retrySave,
      addFiles,
      removePhoto,
      retryPhoto,
      refreshPhoto,
      movePhoto,
      setBlockers,
      setPublished,
      photosBusy,
    ],
  );

  return <WizardContext.Provider value={value}>{children}</WizardContext.Provider>;
}

export function useWizard(): WizardContextValue {
  const value = useContext(WizardContext);
  if (!value) throw new Error("useWizard outside WizardProvider");
  return value;
}
