import { ApiError, apiDelete, apiGet, apiPost, apiPut, uploadToPresignedUrl, type UploadProgress } from "@/lib/auth/client";
import { KYBC_DECLARED_TYPES, MAX_UPLOAD_BYTES, type KybcDeclaredType } from "@/lib/contracts/media";
import { STOCK_API, type StockImportMode, type StockImportResponse, type StockListResponse } from "@/lib/contracts/stock-import";
import { PRO_API, type KybcCompleteResponse, type KybcSignResponse, type ProAgencyInput, type ProAgencyResponse, type ProApplyInput, type ProApplyResponse, type ProMeResponse } from "@/lib/contracts/pro";

// Browser side of /api/pro/** (phase 7 design §4): the Pro area state, one KYBC piece end to end
// (sign, PUT to the presigned URL with progress, complete), the application and the stock import.

export const loadProMe = () => apiGet<ProMeResponse>(PRO_API.me);

export const saveProAgency = (input: ProAgencyInput) => apiPut<ProAgencyResponse>(PRO_API.agency, input);

export const submitProApplication = (input: ProApplyInput) => apiPost<ProApplyResponse>(PRO_API.apply, input);

export function kybcType(file: Pick<File, "type">): KybcDeclaredType | null {
  return (KYBC_DECLARED_TYPES as readonly string[]).includes(file.type) ? (file.type as KybcDeclaredType) : null;
}

/** Refuses locally what the server would refuse (type, size), then sign -> PUT -> complete. */
export async function uploadKybcPiece(file: File, onProgress?: UploadProgress, signal?: AbortSignal): Promise<KybcCompleteResponse> {
  const declaredType = kybcType(file);
  if (!declaredType) return { status: "rejected", uploadId: "", reason: "bad_type" };
  if (file.size > MAX_UPLOAD_BYTES || file.size === 0) return { status: "rejected", uploadId: "", reason: "too_large" };
  const signed = await apiPost<KybcSignResponse>(PRO_API.kybcSign, { declaredType, declaredSize: file.size });
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
