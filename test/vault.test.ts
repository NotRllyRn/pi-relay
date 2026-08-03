import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Vault } from "../src/vault.js";

const setup = async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-relay-"));
	return {
		directory,
		path: join(directory, "relay", "state.json"),
		vault: new Vault(join(directory, "relay", "state.json")),
	};
};
const credential = (access = "access") => ({
	access,
	refresh: "refresh",
	expires: Date.now() + 60_000,
});

test("new vault and profile lifecycle", async () => {
	const { vault } = await setup();
	assert.deepEqual(await vault.listProfiles(), []);
	const profile = await vault.add({ label: "One", credential: credential() });
	assert.equal((await vault.getProfile(profile.id))?.label, "One");
	await vault.update(profile.id, (value) => {
		value.label = "First";
	});
	assert.equal((await vault.getProfile(profile.id))?.label, "First");
	assert.equal(await vault.remove(profile.id), true);
	assert.equal(await vault.getProfile(profile.id), undefined);
});

test("concurrent changes preserve profiles", async () => {
	const { vault } = await setup();
	await Promise.all(
		Array.from({ length: 8 }, (_, index) =>
			vault.add({ label: `${index}`, credential: credential(`${index}`) }),
		),
	);
	assert.equal((await vault.listProfiles()).length, 8);
});

test("serializes refresh work across Vault instances", async () => {
	const { path, vault } = await setup();
	const profile = await vault.add({ label: "One", credential: credential() });
	const other = new Vault(path);
	let active = 0;
	let maxActive = 0;
	const work = (instance: Vault) =>
		instance.withRefreshLock(profile.id, async () => {
			maxActive = Math.max(maxActive, ++active);
			await new Promise((resolve) => setTimeout(resolve, 20));
			active--;
		});
	await Promise.all([work(vault), work(other)]);
	assert.equal(maxActive, 1);
});

test("recovers a stale lock", async () => {
	const { vault } = await setup();
	await mkdir(vault.lockPath, { recursive: true });
	const stale = new Date(Date.now() - 60_000);
	await utimes(vault.lockPath, stale, stale);
	const profile = await vault.add({ label: "One", credential: credential() });
	assert.equal((await vault.getProfile(profile.id))?.label, "One");
});

test("generation compare-and-swap rejects stale refresh", async () => {
	const { vault } = await setup();
	const profile = await vault.add({ label: "One", credential: credential() });
	assert.equal(
		await vault.commitRefresh(profile.id, 0, credential("new")),
		true,
	);
	assert.equal(
		await vault.commitRefresh(profile.id, 0, credential("stale")),
		false,
	);
	assert.equal(
		await vault.updateGeneration(profile.id, 0, (value) => {
			value.needsLogin = true;
		}),
		false,
	);
	assert.equal((await vault.getProfile(profile.id))?.credential.access, "new");
	assert.equal((await vault.getProfile(profile.id))?.needsLogin, undefined);
});

test("quarantines corrupt files and enforces modes", async () => {
	const { directory, path, vault } = await setup();
	await vault.add({ label: "One", credential: credential() });
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.equal((await stat(join(directory, "relay"))).mode & 0o777, 0o700);
	await writeFile(path, "bad json");
	assert.deepEqual(await vault.read(), {
		version: 1,
		settings: { policy: "smart-reset", quotaWait: true, priorityOrder: [] },
		profiles: {},
		migratedNativeAuth: false,
	});
	assert.ok(
		(await readdir(join(directory, "relay"))).some((name) =>
			name.includes(".corrupt-"),
		),
	);
});

test("successful writes leave no temporary file", async () => {
	const { path, vault } = await setup();
	await vault.add({ label: "One", credential: credential() });
	const contents = await readFile(path, "utf8");
	assert.doesNotThrow(() => JSON.parse(contents));
	assert.deepEqual(
		(await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp")),
		[],
	);
});
