import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sodium from "libsodium-wrappers";
import { BUNDLE_FORMAT, knownHostsLine, parseBundle, parsePublicKey, seal, sshKeyPair } from "./github-ci.ts";

const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFKgc0KHBBzVQmqOncxJQjyEaB4sjvacziqfskXXPtcH";

test("seal opens with the repository's private key only", async () => {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  const key = parsePublicKey(JSON.stringify({ key_id: "1234", key: sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL) }));
  const sealed = await seal("secret value", key);
  const opened = sodium.crypto_box_seal_open(sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL), pair.publicKey, pair.privateKey);
  assert.equal(sodium.to_string(opened), "secret value");
});

test("public key and known_hosts are checked", () => {
  assert.throws(() => parsePublicKey('{"key_id":"x","key":"AAAA"}'));
  assert.equal(knownHostsLine(` ${HOST_KEY} `), `ssh.joutiya.ma ${HOST_KEY}`);
  assert.throws(() => knownHostsLine("ssh-rsa AAAAB3Nza"));
});

test("a bundle writes only deploy-staging's names", () => {
  const bundle = { format: BUNDLE_FORMAT, repository: "Vegadarkk/joutiya", keyId: "1234", secrets: { STAGING_DEPLOY_SSH_KEY: "c2VhbGVk" }, variables: { VM_SSH_KNOWN_HOSTS: `ssh.joutiya.ma ${HOST_KEY}`, STAGING_DEPLOY_ENABLED: "true" } };
  assert.equal(parseBundle(JSON.stringify(bundle), "Vegadarkk/joutiya").keyId, "1234");
  assert.throws(() => parseBundle(JSON.stringify(bundle), "someone/else"));
  assert.throws(() => parseBundle(JSON.stringify({ ...bundle, secrets: { NPM_TOKEN: "c2VhbGVk" } }), "Vegadarkk/joutiya"));
  assert.throws(() => parseBundle(JSON.stringify({ ...bundle, variables: { STAGING_DEPLOY_ENABLED: "false" } }), "Vegadarkk/joutiya"));
});

test("the deploy key is an OpenSSH ed25519 key", (t) => {
  const pair = sshKeyPair("deploy-staging@test");
  assert.match(pair.publicKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]+=* deploy-staging@test$/);
  if (spawnSync("ssh-keygen", ["-?"]).error) {
    t.skip("ssh-keygen not installed");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "github-ci-"));
  try {
    writeFileSync(join(dir, "key"), pair.privateKey, { mode: 0o600 });
    const derived = spawnSync("ssh-keygen", ["-y", "-f", join(dir, "key")], { encoding: "utf8" });
    assert.equal(derived.status, 0, derived.stderr);
    assert.equal(derived.stdout.trim(), pair.publicKey);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
