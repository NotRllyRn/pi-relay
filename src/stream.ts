import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { classifyFailure } from "./codex.js";
import { selectProfile, type SelectionOverrides } from "./select.js";
import type { Failure, Policy, RelayProfile } from "./types.js";

export type RelayStreamDependencies = {
  profiles(): Promise<RelayProfile[]>;
  settings(): Promise<{ policy: Policy; priorityOrder: string[] }>;
  overrides(): SelectionOverrides;
  prepare(profile: RelayProfile, signal?: AbortSignal): Promise<RelayProfile["credential"]>;
  stream(model: Model<Api>, context: Context, options: SimpleStreamOptions, profile: RelayProfile): AssistantMessageEventStream;
  failure(profile: RelayProfile, failure: Failure): Promise<void>;
  success(profile: RelayProfile): Promise<void>;
  selected?(profile: RelayProfile, previous?: RelayProfile): void;
  continuation?(details: { requestId: string; profile: RelayProfile; failure: Failure }): void;
  wait?(profiles: RelayProfile[], signal?: AbortSignal): Promise<boolean>;
};

export const isMeaningful = (event: AssistantMessageEvent): boolean =>
  event.type === "text_start" || event.type === "text_delta"
  || event.type === "thinking_start" || event.type === "thinking_delta"
  || event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end";

export function streamRelay(
  model: Model<Api>, context: Context, options: SimpleStreamOptions = {}, dependencies: RelayStreamDependencies,
): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();
  void run(model, context, options, dependencies, outer).catch((error) => {
    outer.push({ type: "error", reason: options.signal?.aborted ? "aborted" : "error", error: errorMessage(model, error, options.signal?.aborted) });
    outer.end();
  });
  return outer;
}

async function run(
  model: Model<Api>, context: Context, options: SimpleStreamOptions, dependencies: RelayStreamDependencies, outer: AssistantMessageEventStream,
): Promise<void> {
  const requestId = randomUUID(), attempted = new Set<string>();
  let meaningful = false, outerStart = false, previous: RelayProfile | undefined, lastError: AssistantMessage | undefined;
  for (let pass = 1; pass <= 3; pass++) {
    for (;;) {
      if (options.signal?.aborted) throw new Error("Request aborted");
      const profiles = await dependencies.profiles();
      const settings = await dependencies.settings();
      const selection = selectProfile(profiles, settings.policy, dependencies.overrides(), Date.now(), attempted, settings.priorityOrder);
      const profile = selection.profile;
      if (!profile) {
        if (dependencies.wait && await dependencies.wait(profiles, options.signal)) { attempted.clear(); continue; }
        break;
      }
      attempted.add(profile.id);
      dependencies.selected?.(profile, previous);
      previous = profile;
      let credential: RelayProfile["credential"];
      try { credential = await dependencies.prepare(profile, options.signal); }
      catch (error) {
        const failure = classifyFailure(error);
        await dependencies.failure(profile, failure);
        if (failure.kind === "auth") continue;
        throw error;
      }
      const inner = dependencies.stream(model, context, { ...options, apiKey: credential.access }, profile);
      let retry = false;
      for await (const event of inner) {
        if (event.type === "start") {
          if (!outerStart) { outer.push(event); outerStart = true; }
          continue;
        }
        if (isMeaningful(event)) meaningful = true;
        if (event.type === "error") {
          lastError = event.error;
          const failure = classifyFailure(event.error.errorMessage ?? "Unknown provider error");
          if (options.signal?.aborted || failure.kind === "aborted") { outer.push(event); outer.end(); return; }
          const switchable = failure.kind === "quota" || failure.kind === "auth" || failure.kind === "rate-limit";
          await dependencies.failure(profile, failure);
          if (switchable && !meaningful) { retry = true; break; }
          if (switchable && meaningful) dependencies.continuation?.({ requestId, profile, failure });
          outer.push(event); outer.end(); return;
        }
        outer.push(event);
        if (event.type === "done") { await dependencies.success(profile); outer.end(event.message); return; }
      }
      if (!retry) throw new Error("Codex stream ended without a terminal event");
    }
    if (pass < 3) attempted.clear();
  }
  if (lastError) outer.push({ type: "error", reason: "error", error: lastError });
  else outer.push({ type: "error", reason: "error", error: errorMessage(model, "No eligible Codex account") });
  outer.end();
}

const errorMessage = (model: Model<Api>, error: unknown, aborted = false): AssistantMessage => ({
  role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
});
