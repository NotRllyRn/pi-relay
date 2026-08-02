import assert from "node:assert/strict";
import test from "node:test";
import { accountLine, formatDuration, formatReset } from "../src/ui.js";
import type { RelayProfile } from "../src/types.js";

test("formats provider window duration and reset", () => {
  assert.equal(formatDuration(18_000), "5h");
  assert.equal(formatDuration(604_800), "7d");
  assert.equal(formatReset(3_700_000, 100_000), "1h0m");
});

test("account lines never contain credentials", () => {
  const profile: RelayProfile = { id: "id", provider: "openai-codex", label: "Personal", credential: { access: "fake-access", refresh: "fake-refresh", expires: 1 }, generation: 0, enabled: true, order: 0, createdAt: 0, updatedAt: 0 };
  const line = accountLine(profile);
  assert.doesNotMatch(line, /fake-access|fake-refresh/);
  assert.match(line, /Personal/);
});
