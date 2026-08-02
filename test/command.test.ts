import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveAccount } from "../src/command.js";
import type { RelayController } from "../src/pi.js";
import { Vault } from "../src/vault.js";

const setup = async () => {
  const vault = new Vault(join(await mkdtemp(join(tmpdir(), "relay-command-")), "state.json"));
  const personal = await vault.add({ label: "Personal", credential: { access: "a", refresh: "r", expires: 1 } });
  const personTwo = await vault.add({ label: "Person Two", credential: { access: "b", refresh: "r2", expires: 1 } });
  return { controller: { vault } as RelayController, personal };
};

test("resolves exact id, label, and unique prefix", async () => {
  const { controller, personal } = await setup();
  assert.equal((await resolveAccount(controller, personal.id)).id, personal.id);
  assert.equal((await resolveAccount(controller, "personal")).id, personal.id);
  assert.equal((await resolveAccount(controller, "person t")).label, "Person Two");
});

test("rejects ambiguous and missing accounts", async () => {
  const { controller } = await setup();
  await assert.rejects(resolveAccount(controller, "person"), /Ambiguous/);
  await assert.rejects(resolveAccount(controller, "missing"), /not found/);
});
