import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { RelayProfile, RelayState } from "./types.js";
import { defaultState } from "./types.js";

const LOCK_STALE_MS = 30_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Vault {
	readonly lockPath: string;
	constructor(readonly path: string) {
		this.lockPath = `${path}.lock`;
	}

	async read(): Promise<RelayState> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		try {
			const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
			if (!isState(parsed)) throw new Error("unsupported state schema");
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return defaultState();
			await rename(this.path, `${this.path}.corrupt-${Date.now()}`).catch(
				() => undefined,
			);
			return defaultState();
		}
	}

	async change<T>(fn: (state: RelayState) => T | Promise<T>): Promise<T> {
		return this.lock(async () => {
			const state = await this.read();
			const result = await fn(state);
			await this.write(state);
			return result;
		});
	}

	async listProfiles(): Promise<RelayProfile[]> {
		return Object.values((await this.read()).profiles);
	}
	async getProfile(id: string): Promise<RelayProfile | undefined> {
		return (await this.read()).profiles[id];
	}

	async add(
		input: Pick<RelayProfile, "label" | "credential">,
	): Promise<RelayProfile> {
		return this.change((state) => {
			const now = Date.now();
			const profile: RelayProfile = {
				id: randomUUID(),
				provider: "openai-codex",
				label: input.label,
				credential: input.credential,
				generation: 0,
				enabled: true,
				order: Object.keys(state.profiles).length,
				createdAt: now,
				updatedAt: now,
			};
			state.profiles[profile.id] = profile;
			state.settings.priorityOrder.push(profile.id);
			return profile;
		});
	}

	async update(
		id: string,
		fn: (profile: RelayProfile) => void,
	): Promise<RelayProfile | undefined> {
		return this.change((state) => {
			const profile = state.profiles[id];
			if (!profile) return undefined;
			fn(profile);
			profile.updatedAt = Date.now();
			return profile;
		});
	}

	async remove(id: string): Promise<boolean> {
		return this.change((state) => {
			if (!state.profiles[id]) return false;
			delete state.profiles[id];
			state.settings.priorityOrder = state.settings.priorityOrder.filter(
				(value) => value !== id,
			);
			return true;
		});
	}

	async commitRefresh(
		id: string,
		generation: number,
		credential: RelayProfile["credential"],
	): Promise<boolean> {
		return this.change((state) => {
			const profile = state.profiles[id];
			if (!profile || profile.generation !== generation) return false;
			profile.credential = credential;
			profile.generation++;
			profile.updatedAt = Date.now();
			return true;
		});
	}

	private async lock<T>(fn: () => Promise<T>): Promise<T> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		for (;;) {
			try {
				await mkdir(this.lockPath);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const lock = await stat(this.lockPath).catch(() => undefined);
				if (!lock) continue;
				if (Date.now() - lock.mtimeMs > LOCK_STALE_MS)
					await rm(this.lockPath, { recursive: true, force: true });
				else await sleep(20);
			}
		}
		try {
			return await fn();
		} finally {
			await rm(this.lockPath, { recursive: true, force: true });
		}
	}

	private async write(state: RelayState): Promise<void> {
		const directory = dirname(this.path);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(`${JSON.stringify(state, null, 2)}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, this.path);
		const directoryHandle = await open(directory, "r");
		try {
			await directoryHandle.sync();
		} finally {
			await directoryHandle.close();
		}
	}
}

const isState = (value: unknown): value is RelayState => {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<RelayState>;
	return (
		state.version === 1 &&
		!!state.settings &&
		!!state.profiles &&
		typeof state.profiles === "object"
	);
};
