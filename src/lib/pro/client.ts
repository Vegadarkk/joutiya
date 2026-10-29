import { ApiError, apiDelete, apiGet, apiPost, apiPut, uploadToPresignedUrl, type UploadProgress } from "@/lib/auth/client";
import { KYBC_DECLARED_TYPES, MAX_UPLOAD_BYTES, type KybcDeclaredType } from "@/lib/contracts/media";
import type { SectionsInput, SectionsResponse } from "@/lib/contracts/catalog";
import { STOCK_API, type StockImportMode, type StockImportResponse, type StockListResponse } from "@/lib/contracts/stock-import";
import { PRO_API, type KybcCompleteResponse, type KybcSignInput, type KybcSignResponse, type RentalCheckResponse, type ProAgencyInput, type ProAgencyResponse, type ProRentalInput, type ProRentalResponse, type ProApplyInput, type ProApplyResponse, type ProMeResponse } from "@/lib/contracts/pro";

// Browser side of /api/pro/** (phase 7 design §4): the Pro area state, one KYBC piece end to end
// (sign, PUT to the presigned URL with progress, complete), the application, the car rental
// agency's licence check and the stock import.

export const loadProMe = () => apiGet<ProMeResponse>(PRO_API.me);

export const saveProAgency = (input: ProAgencyInput) => apiPut<ProAgencyResponse>(PRO_API.agency, input);
export const saveSections = (input: SectionsInput) => apiPut<SectionsResponse>(PRO_API.sections, input);
export const saveRentalAgency = (input: ProRentalInput) => apiPut<ProRentalResponse>(PRO_API.rental, input);

/** Sends the licence decision (a piece uploaded with `use: "agrement"`) for its check (decision 5). */
export const submitRentalCheck = (uploadId: string) => apiPost<RentalCheckResponse>(PRO_API.rentalCheck, { uploadId });

export const submitProApplication = (input: ProApplyInput) => apiPost<ProApplyResponse>(PRO_API.apply, input);

export function kybcType(file: Pick<File, "type">): KybcDeclaredType | null {
  return (KYBC_DECLARED_TYPES as readonly string[]).includes(file.type) ? (file.type as KybcDeclaredType) : null;
}

/** Refuses locally what the server would refuse (type, size), then sign -> PUT -> complete. */
export async function uploadKybcPiece(file: File, onProgress?: UploadProgress, signal?: AbortSignal, use?: KybcSignInput["use"]): Promise<KybcCompleteResponse> {
  const declaredType = kybcType(file);
  if (!declaredType) return { status: "rejected", uploadId: "", reason: "bad_type" };
  if (file.size > MAX_UPLOAD_BYTES || file.size === 0) return { status: "rejected", uploadId: "", reason: "too_large" };
  const signed = await apiPost<KybcSignResponse>(PRO_API.kybcSign, { declaredType, declaredSize: file.size, ...(use ? { use } : {}) });
  await uploadToPresignedUrl(signed.url, signed.headers, file, onProgress, signal);
  if (signal?.aborted) throw new ApiError(0, "aborted");
  return apiPost<KybcCompleteResponse>(PRO_API.kybcComplete(signed.uploadId), {});
}

/** Removes a piece the wizard no longer lists (a piece of an application under review is refused: 409). */
export const removeKybcPiece = (uploadId: string) => apiDelete(PRO_API.kybcDelete(uploadId));

/** The shop's listings with a stock reference (Concession pack). */
export const loadStock = () => apiGet<StockListResponse>(STOCK_API.list);

/** Preview (nothing written) or apply of a stock file, sent as text. */
export const importStockFile = (mode: StockImportMode, csv: string) => apiPost<StockImportResponse>(STOCK_API.import, { mode, csv });
