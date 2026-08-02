import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("loads through Pi's aliased extension loader", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "relay-loader-"));
	const piEntry = fileURLToPath(
		import.meta.resolve("@earendil-works/pi-coding-agent"),
	);
	const loader = join(dirname(piEntry), "core/extensions/loader.js");
	const extension = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"index.ts",
	);
	const script = `
		const { loadExtensions } = await import(${JSON.stringify(loader)});
		const result = await loadExtensions([${JSON.stringify(extension)}], process.cwd());
		if (result.errors.length) throw new Error(result.errors[0].error);
	`;
	try {
		const { stderr } = await execFileAsync(
			process.execPath,
			["--input-type=module", "--eval", script],
			{
				env: { ...process.env, PI_CONFIG_DIR: agentDir },
			},
		);
		assert.equal(stderr, "");
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});
