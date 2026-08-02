import { createHash } from "node:crypto";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { Failure, RelayProfile } from "./types.js";
import type { Vault } from "./vault.js";

const REFRESH_AHEAD_MS = 5 * 60_000;
const refreshes = new Map<string, Promise<RelayProfile["credential"]>>();

type JwtMetadata = { expires?: number; accountId?: string };
export const jwtMetadata = (token: string): JwtMetadata => {
	try {
		const payload = JSON.parse(
			Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
		) as Record<string, unknown>;
		const expires =
			typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
		const auth = payload["https://api.openai.com/auth"];
		const accountId =
			auth &&
			typeof auth === "object" &&
			typeof (auth as Record<string, unknown>).chatgpt_account_id === "string"
				? (auth as Record<string, string>).chatgpt_account_id
				: undefined;
		return {
			...(expires === undefined ? {} : { expires }),
			...(accountId === undefined ? {} : { accountId }),
		};
	} catch {
		return {};
	}
};

export const fingerprint = (value: string): string =>
	createHash("sha256").update(value).digest("hex").slice(0, 8);

export const duplicateProfile = (
	profiles: RelayProfile[],
	credential: RelayProfile["credential"],
): RelayProfile | undefined =>
	profiles.find(
		(profile) =>
			credential.accountId &&
			profile.credential.accountId === credential.accountId,
	) ??
	profiles.find(
		(profile) =>
			fingerprint(profile.credential.refresh) ===
			fingerprint(credential.refresh),
	);

export type RefreshToken = (
	credential: OAuthCredential,
	signal?: AbortSignal,
) => Promise<OAuthCredential>;
const refreshCodex: RefreshToken = (credential, signal) => {
	const refresh = openaiCodexProvider().auth.oauth?.refresh;
	if (!refresh) throw new Error("Pi Codex OAuth refresh is unavailable");
	return refresh(credential, signal);
};

export async function ensureValidToken(
	vault: Vault,
	profile: RelayProfile,
	signal?: AbortSignal,
	now = Date.now(),
	refresh: RefreshToken = refreshCodex,
): Promise<RelayProfile["credential"]> {
	if (profile.credential.expires > now + REFRESH_AHEAD_MS)
		return profile.credential;
	const pending = refreshes.get(profile.id);
	if (pending) return pending;
	const promise = (async () => {
		try {
			const result = await refresh(
				{ type: "oauth", ...profile.credential },
				signal,
			);
			const metadata = jwtMetadata(result.access);
			const credential = {
				access: result.access,
				refresh: result.refresh,
				expires: result.expires,
				...(metadata.accountId || profile.credential.accountId
					? { accountId: metadata.accountId ?? profile.credential.accountId }
					: {}),
			};
			return (await vault.commitRefresh(
				profile.id,
				profile.generation,
				credential,
			))
				? credential
				: ((await vault.getProfile(profile.id))?.credential ?? credential);
		} catch (error) {
			if (/invalid_grant|revoked|unauthorized/i.test(errorMessage(error)))
				await vault.update(profile.id, (value) => {
					value.needsLogin = true;
				});
			throw new Error(sanitizeError(error));
		}
	})();
	refreshes.set(profile.id, promise);
	try {
		return await promise;
	} finally {
		refreshes.delete(profile.id);
	}
}

export const classifyFailure = (error: unknown): Failure => {
	const message = errorMessage(error);
	if (/abort/i.test(message)) return { kind: "aborted", message };
	if (
		/usage_limit_reached|usage_not_included|insufficient_quota|ChatGPT usage limit/i.test(
			message,
		)
	)
		return { kind: "quota", message };
	if (/\b429\b|rate.?limit/i.test(message))
		return { kind: "rate-limit", message };
	if (/\b401\b|invalid_grant|unauthori[sz]ed|token expired/i.test(message))
		return { kind: "auth", recoverable: true, message };
	if (/\b(500|502|503)\b|ECONNRESET|ENOTFOUND|network|timeout/i.test(message))
		return { kind: "transient", message };
	if (/context.?length|unsupported model|tool schema/i.test(message))
		return { kind: "model", message };
	return { kind: "unknown", message };
};

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
const sanitizeError = (error: unknown): string =>
	errorMessage(error).replace(
		/(?:access|refresh)[_-]?token["' :=]+\S+/gi,
		"token [redacted]",
	);
