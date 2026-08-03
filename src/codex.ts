import { createHash } from "node:crypto";
import type { OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
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
			fingerprint(profile.credential.refresh) ===
			fingerprint(credential.refresh),
	);

export const codexProvider = (): Provider<"openai-codex-responses"> => {
	const provider = builtinProviders().find(({ id }) => id === "openai-codex");
	if (!provider) throw new Error("Pi Codex provider is unavailable");
	return provider as Provider<"openai-codex-responses">;
};

export type RefreshToken = (
	credential: OAuthCredential,
	signal?: AbortSignal,
) => Promise<OAuthCredential>;
const refreshCodex: RefreshToken = (credential, signal) => {
	const refresh = codexProvider().auth.oauth?.refresh;
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
	const latest = await vault.getProfile(profile.id);
	if (!latest) throw new Error("Relay account no longer exists");
	syncProfile(profile, latest);
	if (latest.credential.expires > now + REFRESH_AHEAD_MS)
		return latest.credential;
	const key = `${vault.path}:${profile.id}`;
	const pending = refreshes.get(key);
	if (pending) {
		const credential = await pending;
		const current = await vault.getProfile(profile.id);
		if (current) syncProfile(profile, current);
		return credential;
	}
	const promise = vault.withRefreshLock(
		profile.id,
		async () => {
			const current = await vault.getProfile(profile.id);
			if (!current) throw new Error("Relay account no longer exists");
			syncProfile(profile, current);
			if (current.credential.expires > now + REFRESH_AHEAD_MS)
				return current.credential;
			try {
				const result = await refresh(
					{ type: "oauth", ...current.credential },
					signal,
				);
				const metadata = jwtMetadata(result.access);
				const credential = {
					access: result.access,
					refresh: result.refresh,
					expires: result.expires,
					...(metadata.accountId || current.credential.accountId
						? { accountId: metadata.accountId ?? current.credential.accountId }
						: {}),
				};
				await vault.commitRefresh(profile.id, current.generation, credential);
				const saved = await vault.getProfile(profile.id);
				if (saved) syncProfile(profile, saved);
				return saved?.credential ?? credential;
			} catch (error) {
				if (/invalid_grant|revoked|unauthorized/i.test(errorMessage(error)))
					await vault.updateGeneration(
						profile.id,
						current.generation,
						(value) => {
							value.needsLogin = true;
						},
					);
				throw new Error(sanitizeError(error));
			}
		},
		signal,
	);
	refreshes.set(key, promise);
	try {
		return await promise;
	} finally {
		refreshes.delete(key);
	}
}

const syncProfile = (target: RelayProfile, source: RelayProfile): void => {
	target.credential = source.credential;
	target.generation = source.generation;
	if (source.needsLogin === undefined) delete target.needsLogin;
	else target.needsLogin = source.needsLogin;
};

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
