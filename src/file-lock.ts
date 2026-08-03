import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const STALE_MS = 30_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withFileLock<T>(
	path: string,
	fn: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
	for (;;) {
		signal?.throwIfAborted();
		try {
			await mkdir(path, { mode: 0o700 });
			try {
				await writeFile(join(path, "owner"), owner, {
					flag: "wx",
					mode: 0o600,
				});
			} catch (error) {
				await rm(path, { recursive: true, force: true });
				throw error;
			}
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (!(await discardIfStale(path))) await sleep(20);
		}
	}
	try {
		return await fn();
	} finally {
		if ((await readFile(join(path, "owner"), "utf8").catch(() => "")) === owner)
			await rm(path, { recursive: true, force: true });
	}
}

async function discardIfStale(path: string): Promise<boolean> {
	const reaper = `${path}.reaper`;
	try {
		await mkdir(reaper, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	try {
		if (!(await isStale(path))) return false;
		const stale = `${path}.stale-${randomUUID()}`;
		try {
			await rename(path, stale);
			await rm(stale, { recursive: true, force: true });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	} finally {
		await rm(reaper, { recursive: true, force: true });
	}
}

async function isStale(path: string): Promise<boolean> {
	const lock = await stat(path).catch(() => undefined);
	if (!lock || Date.now() - lock.mtimeMs <= STALE_MS) return false;
	let owner: { pid?: unknown };
	try {
		owner = JSON.parse(await readFile(join(path, "owner"), "utf8")) as {
			pid?: unknown;
		};
	} catch {
		return true;
	}
	if (typeof owner.pid !== "number") return true;
	try {
		process.kill(owner.pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}
