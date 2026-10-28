// Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1: where a proxy is set (the cloud
// session), a script would otherwise reach the network around it. Every script that calls an API
// refuses to start in that case. Without a proxy (PC2, CI) nothing changes.

export function envProxyError(env: Record<string, string | undefined> = process.env): string | undefined {
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  if (!proxy || env.NODE_USE_ENV_PROXY === "1") return undefined;
  return "a proxy is set (HTTPS_PROXY) but Node's fetch would bypass it: run again with NODE_USE_ENV_PROXY=1";
}

export function requireEnvProxy(): void {
  const error = envProxyError();
  if (error) throw new Error(error);
}
