import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { codexProvider } from "../src/codex.js";
import { RelayLog } from "../src/log.js";
import { RelayController } from "../src/pi.js";
import { Vault } from "../src/vault.js";

test("pin and unpin update the displayed account immediately", async () => {
	const directory = await mkdtemp(join(tmpdir(), "relay-pin-"));
	const vault = new Vault(join(directory, "state.json"));
	await vault.change((state) => {
		state.migratedNativeAuth = true;
	});
	await vault.add({
		label: "Default",
		credential: { access: "a", refresh: "r", expires: 1 },
	});
	const other = await vault.add({
		label: "Other",
		credential: { access: "b", refresh: "r2", expires: 1 },
	});
	other.quota = {
		fetchedAt: Date.now(),
		primary: { usedPercent: 15, resetAt: Date.now() + 260 * 60_000 },
		secondary: { usedPercent: 2, resetAt: Date.now() + 7 * 86_400_000 },
	};
	let status = "";
	const pi = { appendEntry() {}, sendMessage() {} } as unknown as ExtensionAPI;
	const controller = await RelayController.create(
		pi,
		vault,
		new RelayLog(join(directory, "relay.log")),
	);
	controller.attachContext({
		ui: {
			setStatus: (_key: string, value: string) => {
				status = value;
			},
			setWidget() {},
		},
	} as never);
	controller.pin(other);
	assert.equal(status, "Relay: Other | 85% 4h20m / 98% 7d left | pinned");
	assert.equal((await controller.unpin())?.label, "Default");
	assert.equal(status, "Relay: Default");
});

test("provider preserves Codex identity and model catalog", async () => {
	const directory = await mkdtemp(join(tmpdir(), "relay-provider-"));
	const vault = new Vault(join(directory, "state.json"));
	await vault.change((state) => {
		state.migratedNativeAuth = true;
	});
	const pi = { appendEntry() {}, sendMessage() {} } as unknown as ExtensionAPI;
	const provider = (
		await RelayController.create(
			pi,
			vault,
			new RelayLog(join(directory, "relay.log")),
		)
	).provider();
	assert.equal(provider.id, "openai-codex");
	assert.deepEqual(
		provider.getModels().map((model) => model.id),
		codexProvider()
			.getModels()
			.map((model) => model.id),
	);
	assert.equal(
		await provider.auth.apiKey?.check?.({
			ctx: { env: async () => undefined, fileExists: async () => false },
		}),
		undefined,
	);
});
