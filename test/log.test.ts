import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { redact, RelayLog } from "../src/log.js";

test("recursively redacts secret and conversation keys", () => {
	assert.deepEqual(
		redact({
			token: "x",
			nested: { prompt: "hello", safe: "yes" },
			items: [{ authorization: "bearer" }],
		}),
		{
			token: "[redacted]",
			nested: { prompt: "[redacted]", safe: "yes" },
			items: [{ authorization: "[redacted]" }],
		},
	);
});

test("serializes writes across logger instances", async () => {
	const path = join(
		await mkdtemp(join(tmpdir(), "relay-log-concurrent-")),
		"relay.log",
	);
	const logs = [new RelayLog(path), new RelayLog(path)];
	await Promise.all(
		logs.flatMap((log, process) =>
			Array.from({ length: 10 }, (_, index) =>
				log.write("line", { process, index }),
			),
		),
	);
	assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 20);
});

test("writes owner-only JSONL and rotates", async () => {
	const path = join(await mkdtemp(join(tmpdir(), "relay-log-")), "relay.log");
	const log = new RelayLog(path, 100);
	await log.write("first", {
		accessToken: "fake-token",
		safe: "x".repeat(100),
	});
	await log.write("second");
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.doesNotMatch(
		`${await readFile(path, "utf8")}${await readFile(`${path}.1`, "utf8")}`,
		/fake-token/,
	);
});
