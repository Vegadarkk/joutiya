// Pure parts of the VM launcher (tested by tests/unit/vm-launcher.test.ts): OCI request signing
// with WebCrypto, the same scheme as scripts/oracle-vm.ts, and one launch attempt.

/** Worker secrets (wrangler secret put); unset until the owner's machine puts them. */
export interface Env {
  /** OCID of joutiya-launcher, the OCI user that may only list and create instances. */
  OCI_USER?: string;
  OCI_FINGERPRINT?: string;
  /** Its API private key (PEM, PKCS#8 as the console downloads it, or PKCS#1). */
  OCI_PRIVATE_KEY?: string;
}

type Secrets = Required<Env>;

export interface ShapeConfig {
  ocpus: number;
  memoryInGBs: number;
}

/** src/launch.json, written by `node scripts/oracle-vm.ts launcher` (no secret). */
export interface Launch {
  tenancy: string;
  region: string;
  compartmentId: string;
  displayName: string;
  /** The LaunchInstance body of `oracle-vm.ts create`, without its shapeConfig. */
  request: Record<string, unknown>;
  /** Tried in turn, one a minute. */
  shapes: ShapeConfig[];
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const base64 = (bytes: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(bytes)));

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return [0x80 | bytes.length, ...bytes];
}

/** AlgorithmIdentifier of rsaEncryption (1.2.840.113549.1.1.1), NULL parameters. */
const RSA_ENCRYPTION = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

/**
 * The key as PKCS#8 DER, the only private key format WebCrypto imports: a PKCS#1 key is wrapped.
 * Only the PEM block counts: the console's key file ends with an OCI_API_KEY line, and a copy or a
 * Windows pipe may add a BOM, CRLF, UTF-16 NULs or escaped newlines. Errors never quote the key.
 */
export function pkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const text = pem.replace(/\0/g, "").replace(/\\r/g, "").replace(/\\n/g, "\n");
  const block = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]*?)-----END (?:RSA )?PRIVATE KEY-----/.exec(text);
  if (!block) throw new Error("OCI_PRIVATE_KEY holds no PEM private key block");
  let key: Uint8Array<ArrayBuffer>;
  try {
    key = Uint8Array.from(atob((block[2] ?? "").replace(/[^A-Za-z0-9+/=]/g, "")), (char) => char.charCodeAt(0));
  } catch {
    throw new Error("OCI_PRIVATE_KEY: the PEM block is not base64");
  }
  if (!block[1]) return key;
  const body = [0x02, 0x01, 0x00, ...RSA_ENCRYPTION, 0x04, ...derLength(key.length), ...key];
  return Uint8Array.from([0x30, ...derLength(body.length), ...body]);
}

/** OCIDs and fingerprints are printable ASCII: whatever else a copy added goes. */
const clean = (value: string): string => value.replace(/[^\x21-\x7e]/g, "");

/** OCI's signing string; x-date stands in for date, which fetch may set itself. */
export function signingString(method: string, url: URL, headers: Record<string, string>): { names: string[]; text: string } {
  const names = ["x-date", "(request-target)", "host"];
  if (method === "POST") names.push("content-length", "content-type", "x-content-sha256");
  const value = (name: string): string => (name === "(request-target)" ? `${method.toLowerCase()} ${url.pathname}${url.search}` : (headers[name] ?? ""));
  return { names, text: names.map((name) => `${name}: ${value(name)}`).join("\n") };
}

/** Headers of a signed request. host and content-length are signed but left to fetch, which sends the same values. */
export async function signedHeaders(env: Secrets, tenancy: string, method: "GET" | "POST", url: URL, body: Uint8Array<ArrayBuffer> | undefined, date: Date): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "x-date": date.toUTCString(), host: url.host };
  if (body) {
    headers["content-length"] = String(body.byteLength);
    headers["content-type"] = "application/json";
    headers["x-content-sha256"] = base64(await crypto.subtle.digest("SHA-256", body));
  }
  const { names, text } = signingString(method, url, headers);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8(env.OCI_PRIVATE_KEY), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]).catch(() => {
    throw new Error("OCI_PRIVATE_KEY is not an RSA private key");
  });
  const signature = base64(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(text)));
  const keyId = `${tenancy}/${clean(env.OCI_USER)}/${clean(env.OCI_FINGERPRINT)}`;
  headers.authorization = `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${names.join(" ")}",signature="${signature}"`;
  delete headers.host;
  delete headers["content-length"];
  return headers;
}

async function failure(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const { code, message } = JSON.parse(text) as { code?: string; message?: string };
    return `HTTP ${response.status} ${code ?? ""} ${message ?? ""}`.trim();
  } catch {
    return `HTTP ${response.status} ${text.slice(0, 200)}`;
  }
}

const GONE = ["TERMINATING", "TERMINATED"];

/**
 * One run: nothing while the compartment holds a live instance (never a second VM), otherwise one
 * launch with this minute's shape. Returns the log line; "Out of host capacity" is the usual answer.
 */
export async function launchOnce(launch: Launch, env: Env, scheduledTime: number, fetcher: Fetcher): Promise<string> {
  const { OCI_USER, OCI_FINGERPRINT, OCI_PRIVATE_KEY } = env;
  if (!OCI_USER || !OCI_FINGERPRINT || !OCI_PRIVATE_KEY) {
    return `secrets missing: ${["OCI_USER", "OCI_FINGERPRINT", "OCI_PRIVATE_KEY"].filter((name) => !env[name as keyof Env]).join(", ")}`;
  }
  const secrets = { OCI_USER, OCI_FINGERPRINT, OCI_PRIVATE_KEY };
  const call = async (method: "GET" | "POST", path: string, payload?: unknown): Promise<Response> => {
    const url = new URL(`https://iaas.${launch.region}.oraclecloud.com${path}`);
    const body = payload === undefined ? undefined : new TextEncoder().encode(JSON.stringify(payload));
    return fetcher(url.toString(), { method, headers: await signedHeaders(secrets, launch.tenancy, method, url, body, new Date()), body });
  };
  const list = await call("GET", `/20160918/instances?compartmentId=${encodeURIComponent(launch.compartmentId)}&limit=100`);
  if (!list.ok) return `instance list failed: ${await failure(list)}`;
  const alive = ((await list.json()) as { displayName: string; lifecycleState: string }[]).filter((instance) => !GONE.includes(instance.lifecycleState));
  if (alive.length > 0 || list.headers.has("opc-next-page")) {
    return `instance present (${alive.map((instance) => `${instance.displayName} ${instance.lifecycleState}`).join(", ") || "more than one page"}): nothing launched`;
  }
  const shape = launch.shapes[Math.floor(scheduledTime / 60_000) % launch.shapes.length];
  if (!shape) return "launch.json has no shape";
  const size = `${shape.ocpus} OCPU, ${shape.memoryInGBs} GB`;
  const response = await call("POST", "/20160918/instances", { ...launch.request, shapeConfig: shape });
  if (!response.ok) return `no launch (${size}): ${await failure(response)}`;
  const instance = (await response.json()) as { id: string; lifecycleState: string };
  return `launched ${launch.displayName} ${instance.lifecycleState} (${size}, ${instance.id})`;
}
