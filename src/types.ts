export type Policy = "smart-reset" | "most-available" | "priority-order";

export type QuotaWindow = {
	usedPercent?: number;
	resetAt?: number;
	windowSeconds?: number;
};
export type CodexQuotaSnapshot = {
	primary?: QuotaWindow;
	secondary?: QuotaWindow;
	fetchedAt: number;
	error?: "auth" | "network" | "invalid-response";
};

export type RelayProfile = {
	id: string;
	provider: "openai-codex";
	label: string;
	credential: {
		access: string;
		refresh: string;
		expires: number;
		accountId?: string;
	};
	generation: number;
	enabled: boolean;
	order: number;
	createdAt: number;
	updatedAt: number;
	lastUsedAt?: number;
	lastSuccessAt?: number;
	needsLogin?: boolean;
	exhaustedUntil?: number;
	cooldownUntil?: number;
	skippedUntil?: number;
	quota?: CodexQuotaSnapshot;
};

export type RelayState = {
	version: 1;
	settings: { policy: Policy; quotaWait: boolean; priorityOrder: string[] };
	profiles: Record<string, RelayProfile>;
	migratedNativeAuth: boolean;
};

export type SessionRelayState = {
	version: 1;
	requestId?: string;
	activeProfileId?: string;
	pinnedProfileId?: string;
	prioritizedProfileId?: string;
	phase: "idle" | "streaming" | "continuing" | "waiting" | "paused";
	continuationPending?: boolean;
	waitUntil?: number;
	waitProfileId?: string;
	reason?: "quota" | "auth";
	updatedAt: number;
};

export type Failure =
	| { kind: "quota"; resetAt?: number; message: string }
	| { kind: "rate-limit"; retryAt?: number; message: string }
	| { kind: "auth"; recoverable: boolean; message: string }
	| {
			kind: "transient" | "request" | "model" | "aborted" | "unknown";
			message: string;
	  };

export const defaultState = (): RelayState => ({
	version: 1,
	settings: { policy: "smart-reset", quotaWait: true, priorityOrder: [] },
	profiles: {},
	migratedNativeAuth: false,
});
