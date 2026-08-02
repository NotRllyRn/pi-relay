import assert from "node:assert/strict";
import test from "node:test";
import { fetchUsage, isFresh, poolUsage, UsageError } from "../src/usage.js";
import type { RelayProfile } from "../src/types.js";

const credential = {
	access: "secret-access",
	refresh: "secret-refresh",
	expires: 1,
	accountId: "account",
};
const response = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

test("fetches explicit credential and parses windows", async () => {
	let headers: Headers | undefined;
	const fetcher: typeof fetch = async (_url, init) => {
		headers = new Headers(init?.headers);
		return response({
			rate_limit: {
				primary_window: {
					used_percent: 25,
					reset_at: 100,
					limit_window_seconds: 18000,
				},
				secondary_window: {
					used_percent: 10,
					reset_at: 200,
					limit_window_seconds: 604800,
				},
			},
		});
	};
	const quota = await fetchUsage(credential, undefined, fetcher, 50);
	assert.equal(headers?.get("Authorization"), "Bearer secret-access");
	assert.equal(headers?.get("ChatGPT-Account-Id"), "account");
	assert.deepEqual(quota, {
		primary: { usedPercent: 25, resetAt: 100000, windowSeconds: 18000 },
		secondary: { usedPercent: 10, resetAt: 200000, windowSeconds: 604800 },
		fetchedAt: 50,
	});
});

test("classifies HTTP errors", async () => {
	for (const [status, kind] of [
		[401, "auth"],
		[403, "auth"],
		[429, "rate-limit"],
		[500, "transient"],
		[400, "invalid-response"],
	] as const) {
		await assert.rejects(
			fetchUsage(credential, undefined, async () => response({}, status)),
			(error: UsageError) => error.kind === kind,
		);
	}
});

test("parses ISO and relative reset forms", async () => {
	const quota = await fetchUsage(
		credential,
		undefined,
		async () =>
			response({
				rate_limit: {
					primary_window: {
						used_percent: "5",
						reset_at: "1970-01-01T00:00:10.000Z",
					},
					secondary_window: { used_percent: 10, reset_after_seconds: 30 },
				},
			}),
		1000,
	);
	assert.equal(quota.primary?.resetAt, 10_000);
	assert.equal(quota.secondary?.resetAt, 31_000);
});

test("rejects missing windows and respects cache reset", async () => {
	await assert.rejects(
		fetchUsage(credential, undefined, async () => response({})),
		UsageError,
	);
	assert.equal(
		isFresh({ fetchedAt: 100, primary: { resetAt: 200 } }, 150),
		true,
	);
	assert.equal(
		isFresh({ fetchedAt: 100, primary: { resetAt: 120 } }, 150),
		false,
	);
});

test("calculates pool without counting unknown profiles", () => {
	const profile = (id: string, used?: number): RelayProfile => ({
		id,
		provider: "openai-codex",
		label: id,
		credential,
		generation: 0,
		enabled: true,
		order: 0,
		createdAt: 0,
		updatedAt: 0,
		...(used === undefined
			? {}
			: {
					quota: {
						fetchedAt: 100,
						primary: { usedPercent: used },
						secondary: { usedPercent: used + 10 },
					},
				}),
	});
	assert.deepEqual(
		poolUsage([profile("a", 20), profile("b", 40), profile("c")], 110),
		{ primary: 70, secondary: 60, effective: 60, measured: 2, total: 3 },
	);
});
