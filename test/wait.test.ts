import assert from "node:assert/strict";
import test from "node:test";
import { earliestWake, WaitController } from "../src/wait.js";
import type { RelayProfile } from "../src/types.js";

const profile = (id: string, at: number): RelayProfile => ({
	id,
	provider: "openai-codex",
	label: id,
	credential: { access: "a", refresh: "r", expires: 1 },
	generation: 0,
	enabled: true,
	order: 0,
	createdAt: 0,
	updatedAt: 0,
	exhaustedUntil: at,
});

test("chooses earliest future reset", () => {
	assert.equal(
		earliestWake([profile("a", 200), profile("b", 150)], 100)?.profile.id,
		"b",
	);
});

test("wait wakes once without polling", async () => {
	let wakes = 0;
	const controller = new WaitController(
		async () => {
			wakes++;
		},
		undefined,
		0,
	);
	assert.equal(await controller.wait([profile("a", Date.now() + 10)]), true);
	assert.equal(wakes, 1);
	assert.equal(controller.state, "idle");
});

test("cancel prevents wake", async () => {
	let wakes = 0;
	const controller = new WaitController(
		async () => {
			wakes++;
		},
		undefined,
		0,
	);
	const pending = controller.wait([profile("a", Date.now() + 100)]);
	controller.cancel();
	assert.equal(await pending, false);
	assert.equal(wakes, 0);
});

test("pause preserves paused state", async () => {
	const controller = new WaitController(async () => undefined, undefined, 0);
	const pending = controller.wait([profile("a", Date.now() + 100)]);
	controller.pause();
	assert.equal(await pending, false);
	assert.equal(controller.state, "paused");
	controller.resume();
	assert.equal(controller.state, "idle");
});

test("override wakes a live wait immediately", async () => {
	const controller = new WaitController(async () => undefined, undefined, 0);
	const pending = controller.wait([profile("a", Date.now() + 100)]);
	controller.override();
	assert.equal(await pending, true);
	assert.equal(controller.state, "idle");
});
