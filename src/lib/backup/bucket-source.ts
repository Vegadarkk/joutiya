import { AwsClient } from "aws4fetch";
import type { BackupSource } from "./restore.ts";

// Backup objects read straight from the private R2 bucket (restore --from-bucket): ListObjectsV2
// under `backups/` and GetObject, SigV4 through aws4fetch like src/lib/storage/s3.ts (which is
// server-only, so not importable by the restore script). Read-only; the objects stay encrypted
// until the restore decrypts them in memory. Pure module (no server-only, no "@/").

export interface BucketSourceConfig {
  /** https://<account>.eu.r2.cloudflarestorage.com */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix?: string;
  fetch?: typeof fetch;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function xmlText(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name] as string);
}

/** Keys, truncation flag and continuation token of one ListObjectsV2 page. */
export function parseListPage(xml: string): { keys: string[]; next: string | null } {
  const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((match) => xmlText(match[1] as string));
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml);
  const token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { keys, next: truncated && token ? xmlText(token) : null };
}

export function bucketSource(config: BucketSourceConfig): BackupSource {
  const endpoint = config.endpoint.replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(endpoint)) throw new Error("R2_S3_ENDPOINT must be an https origin");
  const prefix = config.prefix ?? "backups/";
  const client = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: "s3", region: "auto", retries: 0 });
  const fetchImpl = config.fetch ?? fetch;
  const bucketUrl = `${endpoint}/${encodeURIComponent(config.bucket)}`;

  async function send(url: URL, what: string): Promise<Response> {
    const response = await fetchImpl(await client.sign(url, { method: "GET" }));
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${what} on bucket ${config.bucket} failed with HTTP ${response.status}`);
    }
    return response;
  }

  return {
    label: `bucket ${config.bucket}`,
    async list() {
      const keys: string[] = [];
      let token: string | null = null;
      do {
        const url = new URL(bucketUrl);
        url.searchParams.set("list-type", "2");
        url.searchParams.set("prefix", prefix);
        if (token) url.searchParams.set("continuation-token", token);
        const page = parseListPage(await (await send(url, "ListObjectsV2")).text());
        keys.push(...page.keys);
        token = page.next;
      } while (token);
      return keys;
    },
    async read(key) {
      const url = new URL(`${bucketUrl}/${key.split("/").map(encodeURIComponent).join("/")}`);
      return new Uint8Array(await (await send(url, `GET ${key}`)).arrayBuffer());
    },
  };
}
