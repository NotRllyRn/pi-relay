import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	classifyFailure,
	duplicateProfile,
	ensureValidToken,
	fingerprint,
	jwtMetadata,
} from "../src/codex.js";
import { Vault } from "../src/vault.js";

const jwt = (payload: object) =>
	`x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.x`;
const setup = async (expires = Date.now() - 1) => {
	const vault = new Vault(
		join(await mkdtemp(join(tmpdir(), "relay-codex-")), "state.json"),
	);
	const profile = await vault.add({
		label: "One",
		credential: { access: jwt({ exp: 1 }), refresh: "refresh", expires },
	});
	return { vault, profile };
};

test("decodes JWT metadata without trusting malformed input", () => {
	const metadata = jwtMetadata(
		jwt({
			exp: 123,
			"https://api.openai.com/auth": { chatgpt_account_id: "account" },
		}),
	);
	assert.deepEqual(metadata, { expires: 123000, accountId: "account" });
	assert.deepEqual(jwtMetadata("bad"), {});
	assert.equal(fingerprint("secret").length, 8);
});

test("refreshes near expiry and persists rotated refresh token", async () => {
	const { vault, profile } = await setup(Date.now() + 60_000);
	const refresh = async () => ({
		type: "oauth" as const,
		access: jwt({ exp: 9999999999 }),
		refresh: "rotated",
		expires: 9999999999000,
	});
	const value = await ensureValidToken(
		vault,
		profile,
		undefined,
		Date.now(),
		refresh,
	);
	assert.equal(value.refresh, "rotated");
	assert.equal((await vault.getProfile(profile.id))?.generation, 1);
});

test("deduplicates concurrent refresh and protects newer generation", async () => {
	const { vault, profile } = await setup();
	let calls = 0;
	const refresh = async () => {
		calls++;
		await new Promise((resolve) => setTimeout(resolve, 20));
		return {
			type: "oauth" as const,
			access: "new",
			refresh: "new-refresh",
			expires: Date.now() + 999999,
		};
	};
	const second = structuredClone(profile);
	await Promise.all([
		ensureValidToken(vault, profile, undefined, Date.now(), refresh),
		ensureValidToken(vault, second, undefined, Date.now(), refresh),
	]);
	assert.equal(calls, 1);
	assert.equal(second.generation, 1);
});

test("uses a refresh committed by another process instead of stale credentials", async () => {
	const { vault, profile } = await setup();
	await vault.commitRefresh(profile.id, profile.generation, {
		access: "new",
		refresh: "new-refresh",
		expires: Date.now() + 999_999,
	});
	let calls = 0;
	const credential = await ensureValidToken(
		vault,
		profile,
		undefined,
		Date.now(),
		async () => {
			calls++;
			throw new Error("invalid_grant");
		},
	);
	assert.equal(calls, 0);
	assert.equal(credential.refresh, "new-refresh");
	assert.equal(profile.generation, 1);
	assert.equal((await vault.getProfile(profile.id))?.needsLogin, undefined);
});

test("invalid grant marks profile as needing login", async () => {
	const { vault, profile } = await setup();
	await assert.rejects(
		ensureValidToken(vault, profile, undefined, Date.now(), async () => {
			throw new Error("invalid_grant");
		}),
	);
	assert.equal((await vault.getProfile(profile.id))?.needsLogin, true);
});

test("detects only duplicate credentials, not shared account ids", async () => {
	const { profile } = await setup();
	profile.credential.accountId = "same";
	assert.equal(
		duplicateProfile([profile], {
			access: "a",
			refresh: "other",
			expires: 1,
			accountId: "same",
		}),
		undefined,
	);
	assert.equal(
		duplicateProfile([profile], {
			access: "other-access",
			refresh: profile.credential.refresh,
			expires: 1,
		})?.id,
		profile.id,
	);
	assert.equal(classifyFailure(new Error("usage_limit_reached")).kind, "quota");
	assert.equal(
		classifyFailure(new Error("429 too many requests")).kind,
		"rate-limit",
	);
	assert.equal(classifyFailure(new Error("ECONNRESET")).kind, "transient");
});
