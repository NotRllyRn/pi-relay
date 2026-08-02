import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import { isMeaningful, streamRelay, type RelayStreamDependencies } from "../src/stream.js";
import type { Failure, RelayProfile } from "../src/types.js";

const model = { id: "codex", provider: "openai-codex", api: "openai-codex-responses", name: "Codex", baseUrl: "x", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 } as Model<Api>;
const message = (stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage => ({ role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: 1 });
const profile = (id: string, order: number): RelayProfile => ({ id, provider: "openai-codex", label: id, credential: { access: `token-${id}`, refresh: "r", expires: 9999999999999 }, generation: 0, enabled: true, order, createdAt: 0, updatedAt: 0 });
const events = (...values: AssistantMessageEvent[]) => { const stream = createAssistantMessageEventStream(); queueMicrotask(() => { values.forEach((event) => stream.push(event)); stream.end(); }); return stream; };
const start = { type: "start", partial: message("pending") } as const;
const quota = { type: "error", reason: "error", error: message("error", "usage_limit_reached") } as const;
const done = { type: "done", reason: "stop", message: message("stop") } as const;
const textStart = { type: "text_start", contentIndex: 0, partial: message("pending") } as const;

const dependencies = (stream: RelayStreamDependencies["stream"], profiles = [profile("a", 0), profile("b", 1)]) => {
  const failures: Failure[] = [], continuations: unknown[] = [], attempts: string[] = [];
  const deps: RelayStreamDependencies = {
    profiles: async () => profiles,
    settings: async () => ({ policy: "priority-order", priorityOrder: profiles.map((value) => value.id) }),
    overrides: () => ({}), prepare: async (value) => value.credential,
    stream: (model, context, options, value) => { attempts.push(value.id); return stream(model, context, options, value); },
    failure: async (_profile, failure) => { failures.push(failure); }, success: async () => undefined,
    continuation: (details) => { continuations.push(details); },
  };
  return { deps, failures, continuations, attempts };
};
const collect = async (deps: RelayStreamDependencies) => { const result: AssistantMessageEvent[] = []; for await (const event of streamRelay(model, { messages: [] }, {}, deps)) result.push(event); return result; };

test("start is not meaningful output", () => {
  assert.equal(isMeaningful(start), false);
  assert.equal(isMeaningful(textStart), true);
});

test("retries pre-output quota once with one outer start", async () => {
  const fixture = dependencies((_model, _context, _options, value) => value.id === "a" ? events(start, quota) : events(start, done));
  const output = await collect(fixture.deps);
  assert.deepEqual(fixture.attempts, ["a", "b"]);
  assert.equal(output.filter((event) => event.type === "start").length, 1);
  assert.equal(output.at(-1)?.type, "done");
});

test("partial output schedules continuation without replay", async () => {
  const fixture = dependencies(() => events(start, textStart, quota));
  const output = await collect(fixture.deps);
  assert.deepEqual(fixture.attempts, ["a"]);
  assert.equal(fixture.continuations.length, 1);
  assert.equal(output.at(-1)?.type, "error");
});

test("network errors surface without rotating", async () => {
  const network = { type: "error", reason: "error", error: message("error", "ECONNRESET") } as const;
  const fixture = dependencies(() => events(start, network));
  const output = await collect(fixture.deps);
  assert.deepEqual(fixture.attempts, ["a"]);
  assert.equal(output.at(-1)?.type, "error");
});

test("bounds attempts to three passes", async () => {
  const only = profile("a", 0);
  const fixture = dependencies(() => events(start, quota), [only]);
  await collect(fixture.deps);
  assert.deepEqual(fixture.attempts, ["a", "a", "a"]);
});

test("no eligible account still emits a valid start and error", async () => {
  const fixture = dependencies(() => events(), []);
  const output = await collect(fixture.deps);
  assert.deepEqual(output.map((event) => event.type), ["start", "error"]);
});
