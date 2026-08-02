import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RelayLog } from "../src/log.js";
import { RelayController } from "../src/pi.js";
import { Vault } from "../src/vault.js";

test("provider preserves Codex identity and model catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-provider-"));
  const vault = new Vault(join(directory, "state.json"));
  await vault.change((state) => { state.migratedNativeAuth = true; });
  const pi = { appendEntry() {}, sendMessage() {} } as unknown as ExtensionAPI;
  const provider = (await RelayController.create(pi, vault, new RelayLog(join(directory, "relay.log")))).provider();
  assert.equal(provider.id, "openai-codex");
  assert.deepEqual(provider.getModels().map((model) => model.id), openaiCodexProvider().getModels().map((model) => model.id));
  assert.equal(await provider.auth.apiKey?.check?.({ ctx: { env: async () => undefined, fileExists: async () => false } }), undefined);
});
