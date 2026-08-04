import assert from "node:assert/strict";
import test from "node:test";
import { isEligible, selectProfile } from "../src/select.js";
import type { RelayProfile } from "../src/types.js";

const profile = (
	id: string,
	used = 50,
	resetAt = 1000,
	order = 0,
): RelayProfile => ({
	id,
	provider: "openai-codex",
	label: id,
	credential: { access: "a", refresh: "r", expires: 10000 },
	generation: 0,
	enabled: true,
	order,
	createdAt: 0,
	updatedAt: 0,
	quota: {
		fetchedAt: 0,
		primary: { usedPercent: used, resetAt },
		secondary: { usedPercent: used, resetAt: resetAt + 100 },
	},
});

test("filters unavailable states and expires temporary exclusions", () => {
	const attempted = new Set(["attempted"]);
	for (const value of [
		{ ...profile("disabled"), enabled: false },
		{ ...profile("login"), needsLogin: true },
		{ ...profile("skip"), skippedUntil: 500 },
		{ ...profile("cool"), cooldownUntil: 500 },
		{ ...profile("exhaust"), exhaustedUntil: 500 },
		profile("attempted"),
		profile("zero", 100),
	])
		assert.equal(isEligible(value, 100, attempted), false, value.id);
	assert.equal(isEligible({ ...profile("old"), skippedUntil: 50 }, 100), true);
});

test("smart reset spends the long window expiring soonest", () => {
	const soonerLong = profile("sooner-long", 20, 500, 1),
		soonerShort = profile("sooner-short", 20, 100, 2);
	soonerLong.quota!.secondary!.resetAt = 300;
	soonerShort.quota!.secondary!.resetAt = 400;
	assert.equal(
		selectProfile([soonerShort, soonerLong], "smart-reset", {}, 0).profile?.id,
		"sooner-long",
	);

	const polina = profile("polina", 0, 180),
		alejandro = profile("alejandro", 71, 75),
		arina = profile("arina", 15, 260);
	polina.quota!.secondary = { usedPercent: 73, resetAt: 1180 };
	alejandro.quota!.secondary = { usedPercent: 75, resetAt: 981 };
	arina.quota!.secondary = { usedPercent: 2, resetAt: 10_080 };
	assert.equal(
		selectProfile([polina, alejandro, arina], "smart-reset", {}, 0).profile?.id,
		"alejandro",
	);
});

test("keeps the active account until the server rejects it", () => {
	const active = { ...profile("active", 100), exhaustedUntil: 500 },
		other = profile("other");
	assert.equal(
		selectProfile(
			[active, other],
			"smart-reset",
			{ activeProfileId: active.id },
			100,
		).profile?.id,
		active.id,
	);
	assert.equal(
		selectProfile(
			[active, other],
			"smart-reset",
			{ activeProfileId: active.id },
			100,
			new Set([active.id]),
		).profile?.id,
		other.id,
	);
});

test("most available and priority order are exact", () => {
	const a = profile("a", 60, 300),
		b = profile("b", 20, 500);
	assert.equal(selectProfile([a, b], "most-available", {}, 0).profile?.id, "b");
	assert.equal(
		selectProfile([a, b], "priority-order", {}, 0, new Set(), ["b", "a"])
			.profile?.id,
		"b",
	);
});

test("known quota ranks before unknown and overrides take precedence", () => {
	const a = profile("a"),
		{ quota: _quota, ...unknown } = profile("unknown");
	assert.equal(
		selectProfile([unknown, a], "smart-reset", {}, 0).profile?.id,
		"a",
	);
	assert.equal(
		selectProfile(
			[a, unknown],
			"smart-reset",
			{ pinnedProfileId: "unknown" },
			0,
		).source,
		"pin",
	);
	assert.deepEqual(
		selectProfile(
			[a, unknown],
			"smart-reset",
			{ prioritizedProfileId: "unknown" },
			0,
		),
		{ profile: unknown, source: "priority", consumePriority: true },
	);
});

test("clears a permanently ineligible pin", () => {
	const pinned = { ...profile("a"), enabled: false },
		b = profile("b");
	const result = selectProfile(
		[pinned, b],
		"smart-reset",
		{ pinnedProfileId: "a" },
		0,
	);
	assert.equal(result.profile?.id, "b");
	assert.equal(result.clearPin, true);
});
