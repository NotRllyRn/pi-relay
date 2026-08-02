import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RelayLog } from "../src/log.js";
import { CONTINUE_PROMPT, RelayController } from "../src/pi.js";
import type { Failure, RelayProfile } from "../src/types.js";
import { Vault } from "../src/vault.js";

test("partial-output recovery queues one hidden follow-up", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-continuation-"));
  const vault = new Vault(join(directory, "state.json"));
  await vault.change((state) => { state.migratedNativeAuth = true; state.settings.policy = "priority-order"; });
  const quota = { fetchedAt: Date.now(), primary: { usedPercent: 10, resetAt: Date.now() + 60_000 }, secondary: { usedPercent: 10, resetAt: Date.now() + 120_000 } };
  const first = await vault.add({ label: "First", credential: { access: "a", refresh: "r1", expires: Date.now() + 999_999 } });
  const second = await vault.add({ label: "Second", credential: { access: "b", refresh: "r2", expires: Date.now() + 999_999 } });
  await vault.update(first.id, (profile) => { profile.quota = quota; profile.exhaustedUntil = Date.now() + 60_000; });
  await vault.update(second.id, (profile) => { profile.quota = quota; });
  const messages: Array<{ message: unknown; options: unknown }> = [];
  const pi = {
    appendEntry() {},
    sendMessage(message: unknown, options: unknown) { messages.push({ message, options }); },
  } as unknown as ExtensionAPI;
  const controller = await RelayController.create(pi, vault, new RelayLog(join(directory, "relay.log")));
  const failure: Failure = { kind: "quota", message: "usage_limit_reached" };
  (controller as unknown as { pending: { requestId: string; profile: RelayProfile; failure: Failure; queued: boolean } }).pending = { requestId: "request", profile: first, failure, queued: false };
  await controller.handleAgentEnd();
  await controller.handleAgentEnd();
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    message: { customType: "pi-relay-continuation", content: CONTINUE_PROMPT, display: false, details: { requestId: "request", fromProfileId: first.id, toProfileId: second.id } },
    options: { triggerTurn: true, deliverAs: "followUp" },
  });
});
