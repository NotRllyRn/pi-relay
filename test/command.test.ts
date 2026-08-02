import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { registerRelayCommand, resolveAccount } from "../src/command.js";
import type { RelayController } from "../src/pi.js";
import { Vault } from "../src/vault.js";

const setup = async () => {
	const vault = new Vault(
		join(await mkdtemp(join(tmpdir(), "relay-command-")), "state.json"),
	);
	const personal = await vault.add({
		label: "Personal",
		credential: { access: "a", refresh: "r", expires: 1 },
	});
	await vault.add({
		label: "Person Two",
		credential: { access: "b", refresh: "r2", expires: 1 },
	});
	return { controller: { vault } as RelayController, personal };
};

test("resolves exact id, label, and unique prefix", async () => {
	const { controller, personal } = await setup();
	assert.equal((await resolveAccount(controller, personal.id)).id, personal.id);
	assert.equal((await resolveAccount(controller, "personal")).id, personal.id);
	assert.equal(
		(await resolveAccount(controller, "person t")).label,
		"Person Two",
	);
});

test("renames the imported Default profile", async () => {
	const vault = new Vault(
		join(await mkdtemp(join(tmpdir(), "relay-rename-")), "state.json"),
	);
	const profile = await vault.add({
		label: "Default",
		credential: { access: "a", refresh: "r", expires: 1 },
	});
	let handler: (
		input: string,
		context: ExtensionCommandContext,
	) => Promise<void> | void = () => {};
	registerRelayCommand(
		{
			registerCommand: (
				_name: string,
				command: { handler: typeof handler },
			) => {
				handler = command.handler;
			},
		} as unknown as ExtensionAPI,
		{ vault } as RelayController,
	);
	await handler("rename Default Personal", {
		hasUI: true,
		ui: { notify() {} },
	} as unknown as ExtensionCommandContext);
	assert.equal((await vault.getProfile(profile.id))?.label, "Personal");
});

test("root menu renames and deletes profiles", async () => {
	const vault = new Vault(
		join(await mkdtemp(join(tmpdir(), "relay-menu-")), "state.json"),
	);
	const profile = await vault.add({
		label: "Default",
		credential: { access: "a", refresh: "r", expires: 1 },
	});
	let handler: (
		input: string,
		context: ExtensionCommandContext,
	) => Promise<void> | void = () => {};
	const controller = {
		vault,
		freshProfiles: () => vault.listProfiles(),
		activeId: () => undefined,
		pinnedId: () => undefined,
		overrides: () => ({}),
		clearProfileReferences() {},
	} as unknown as RelayController;
	registerRelayCommand(
		{
			registerCommand: (
				_name: string,
				command: { handler: typeof handler },
			) => {
				handler = command.handler;
			},
		} as unknown as ExtensionAPI,
		controller,
	);
	const choices = ["Rename account", `Default · ${profile.id.slice(0, 8)}`];
	await handler("", {
		hasUI: true,
		ui: {
			notify() {},
			select: async () => choices.shift(),
			input: async () => "Personal",
		},
	} as unknown as ExtensionCommandContext);
	assert.equal((await vault.getProfile(profile.id))?.label, "Personal");

	choices.push("Delete account", `Personal · ${profile.id.slice(0, 8)}`);
	await handler("", {
		hasUI: true,
		mode: "tui",
		ui: {
			notify() {},
			select: async () => choices.shift(),
			confirm: async () => true,
		},
	} as unknown as ExtensionCommandContext);
	assert.equal(await vault.getProfile(profile.id), undefined);
});

test("rejects ambiguous and missing accounts", async () => {
	const { controller } = await setup();
	await assert.rejects(resolveAccount(controller, "person"), /Ambiguous/);
	await assert.rejects(resolveAccount(controller, "missing"), /not found/);
});
