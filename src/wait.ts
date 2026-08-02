import type { RelayProfile } from "./types.js";

export const earliestWake = (
	profiles: RelayProfile[],
	now = Date.now(),
): { profile: RelayProfile; at: number } | undefined => {
	const candidates = profiles
		.filter((profile) => profile.enabled && !profile.needsLogin)
		.flatMap((profile) =>
			[
				profile.exhaustedUntil,
				profile.cooldownUntil,
				profile.quota?.primary?.resetAt,
				profile.quota?.secondary?.resetAt,
			]
				.filter((at): at is number => at !== undefined && at > now)
				.map((at) => ({ profile, at })),
		);
	return candidates.sort((a, b) => a.at - b.at)[0];
};

export class WaitController {
	private timer: NodeJS.Timeout | undefined;
	private resolve: ((value: boolean) => void) | undefined;
	private overridden = false;
	state: "idle" | "waiting" | "paused" = "idle";

	constructor(
		private readonly wake: (profile: RelayProfile) => Promise<void>,
		private readonly changed: (
			state: "idle" | "waiting" | "paused",
			wake?: { profile: RelayProfile; at: number },
		) => void = () => undefined,
		private readonly graceMs = 5_000,
	) {}

	async wait(profiles: RelayProfile[], signal?: AbortSignal): Promise<boolean> {
		const next = earliestWake(profiles);
		if (!next || signal?.aborted) return false;
		this.clear();
		this.overridden = false;
		this.state = "waiting";
		this.changed("waiting", next);
		const woke = await new Promise<boolean>((resolve) => {
			const finish = (value: boolean) => {
				if (this.resolve !== finish) return;
				signal?.removeEventListener("abort", onAbort);
				this.clearTimer();
				resolve(value);
			};
			const onAbort = () => finish(false);
			this.resolve = finish;
			this.timer = setTimeout(
				() => finish(true),
				Math.max(0, next.at + this.graceMs - Date.now()),
			);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		if (this.overridden) {
			this.overridden = false;
			return true;
		}
		if (!woke || this.state !== "waiting") return false;
		await this.wake(next.profile);
		this.state = "idle";
		this.changed("idle");
		return true;
	}

	cancel(): void {
		this.stop(false);
		this.state = "idle";
		this.changed("idle");
	}
	pause(): void {
		this.stop(false);
		this.state = "paused";
		this.changed("paused");
	}
	resume(): void {
		if (this.state === "paused") {
			this.state = "idle";
			this.changed("idle");
		}
	}
	override(): void {
		this.overridden = true;
		this.stop(true);
		this.state = "idle";
		this.changed("idle");
	}

	private clear(): void {
		this.stop(false);
		this.state = "idle";
	}
	private stop(value: boolean): void {
		this.resolve ? this.resolve(value) : this.clearTimer();
	}
	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.resolve = undefined;
	}
}
