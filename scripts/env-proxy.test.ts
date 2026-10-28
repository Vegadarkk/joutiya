import assert from "node:assert/strict";
import { test } from "node:test";
import { envProxyError } from "./env-proxy.ts";

test("a set proxy needs NODE_USE_ENV_PROXY=1", () => {
  assert.equal(envProxyError({}), undefined);
  assert.match(envProxyError({ HTTPS_PROXY: "http://127.0.0.1:1" }) ?? "", /NODE_USE_ENV_PROXY=1/);
  assert.match(envProxyError({ https_proxy: "http://127.0.0.1:1", NODE_USE_ENV_PROXY: "0" }) ?? "", /bypass/);
  assert.equal(envProxyError({ HTTPS_PROXY: "http://127.0.0.1:1", NODE_USE_ENV_PROXY: "1" }), undefined);
});
