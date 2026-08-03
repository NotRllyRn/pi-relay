import assert from "node:assert/strict";
import test from "node:test";
import {
	accountLine,
	compactUsage,
	formatDuration,
	formatReset,
} from "../src/ui.js";
import type { RelayProfile } from "../src/types.js";

test("formats provider window duration and reset", () => {
	assert.equal(formatDuration(18_000), "5h");
	assert.equal(formatDuration(604_800), "7d");
	assert.equal(formatReset(3_700_000, 100_000), "1h0m");
});

test("formats compact active-account usage", () => {
	const profile = {
		quota: {
			fetchedAt: 0,
			primary: { usedPercent: 15, resetAt: 260 * 60_000 },
			secondary: { usedPercent: 2, resetAt: 7 * 86_400_000 },
		},
	} as RelayProfile;
	assert.equal(compactUsage(profile, 0), "85% 4h20m / 98% 7d left");
});

test("account lines never contain credentials", () => {
	const profile: RelayProfile = {
		id: "id",
		provider: "openai-codex",
		label: "Personal",
		credential: { access: "fake-access", refresh: "fake-refresh", expires: 1 },
		generation: 0,
		enabled: true,
		order: 0,
		createdAt: 0,
		updatedAt: 0,
	};
	const line = accountLine(profile);
	assert.doesNotMatch(line, /fake-access|fake-refresh/);
	assert.match(line, /Personal/);
});
