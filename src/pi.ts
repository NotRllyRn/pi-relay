import type {
  ApiStreamOptions, Context, Credential, Model, Provider, SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { duplicateProfile, ensureValidToken, fingerprint, jwtMetadata } from "./codex.js";
import type { RelayLog } from "./log.js";
import { selectProfile, earliestFutureReset, type Selection } from "./select.js";
import { streamRelay, type RelayStreamDependencies } from "./stream.js";
import type { Failure, RelayProfile, SessionRelayState } from "./types.js";
import { fetchUsage, isFresh, limitingRemaining, UsageError } from "./usage.js";
import type { Vault } from "./vault.js";
import { WaitController } from "./wait.js";

const MARKER = "pi-relay-managed";
export const CONTINUE_PROMPT = "Resume the existing task from the current session state. Inspect prior assistant text, completed tool calls, and tool results. Do not repeat completed side effects. Continue with the next unfinished step.";

type Pending = { requestId: string; profile: RelayProfile; failure: Failure; queued: boolean };

export class RelayController {
  readonly wait: WaitController;
  private context: ExtensionContext | undefined;
  private pinnedProfileId: string | undefined;
  private prioritizedProfileId: string | undefined;
  private activeProfileId: string | undefined;
  private activeLabel: string | undefined;
  private pending: Pending | undefined;
  private restoredCheckpoint: SessionRelayState | undefined;
  private switches = 0;

  private constructor(
    readonly pi: ExtensionAPI,
    readonly vault: Vault,
    readonly log: RelayLog,
    readonly base: Provider<"openai-codex-responses">,
  ) {
    this.wait = new WaitController((profile) => this.refreshProfile(profile, true), (state, wake) => this.waitChanged(state, wake));
  }

  static async create(pi: ExtensionAPI, vault: Vault, log: RelayLog): Promise<RelayController> {
    const controller = new RelayController(pi, vault, log, openaiCodexProvider());
    await controller.migrate();
    await log.write("start", { version: "0.1.0" });
    return controller;
  }

  provider(): Provider<"openai-codex-responses"> {
    const dependencies = this.dependencies();
    return {
      ...this.base,
      name: "OpenAI Codex (Pi Relay)",
      auth: {
        apiKey: {
          name: "Pi Relay Codex account",
          login: async (interaction) => {
            const label = await interaction.prompt({ type: "text", message: "Account label" });
            const access = await interaction.prompt({ type: "secret", message: "Access token" });
            const refresh = await interaction.prompt({ type: "secret", message: "Refresh token" });
            await this.addProfile(label, access, refresh, interaction.signal);
            return { type: "api_key", key: MARKER };
          },
          check: async () => await this.hasUsableProfile() ? { type: "api_key", source: "Pi Relay" } : undefined,
          resolve: async () => await this.hasUsableProfile() ? { auth: { apiKey: MARKER }, source: "Pi Relay" } : undefined,
        },
      },
      streamSimple: (model, context, options) => streamRelay(model, context, options, dependencies),
      stream: <T extends "openai-codex-responses">(model: Model<T>, context: Context, options?: ApiStreamOptions<T>) =>
        streamRelay(model, context, options as SimpleStreamOptions | undefined, {
          ...dependencies,
          stream: (_model, _context, relayOptions, _profile) => this.base.stream(model, context, { ...options, apiKey: relayOptions.apiKey ?? "" } as ApiStreamOptions<T>),
        }),
    };
  }

  attachContext(context: ExtensionContext): void { this.context = context; this.updateStatus(); }
  detachContext(): void { if (this.wait.state === "waiting") this.wait.pause(); this.context?.ui.setStatus("pi-relay", undefined); this.context?.ui.setWidget("pi-relay", undefined); this.context = undefined; }

  async restore(context: ExtensionContext): Promise<void> {
    this.attachContext(context);
    const entries = context.sessionManager.getEntries();
    const entry = [...entries].reverse().find((value) => value.type === "custom" && value.customType === "pi-relay-state");
    const state = entry?.type === "custom" ? entry.data as SessionRelayState : undefined;
    this.restoredCheckpoint = state;
    if (state?.phase === "waiting" || state?.phase === "paused" || state?.continuationPending) {
      this.wait.pause();
      context.ui.setStatus("pi-relay", "Relay: PAUSED | /relay wait resume");
      context.ui.setWidget("pi-relay", ["PI RELAY PAUSED", "Saved interrupted task: /relay wait resume"]);
    }
  }

  async handleAgentEnd(): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.queued) return;
    const profiles = await this.freshProfiles();
    const state = await this.vault.read();
    const next = selectProfile(profiles, state.settings.policy, this.overrides(), Date.now(), new Set([pending.profile.id]), state.settings.priorityOrder).profile;
    if (next) return this.queueContinuation(pending, next);
    if (!state.settings.quotaWait) return;
    void this.wait.wait(profiles).then(async (woke) => {
      if (!woke || this.pending !== pending) return;
      const refreshed = await this.freshProfiles();
      const current = await this.vault.read();
      const selected = selectProfile(refreshed, current.settings.policy, this.overrides(), Date.now(), new Set(), current.settings.priorityOrder).profile;
      if (selected) this.queueContinuation(pending, selected);
    });
  }

  settled(): void {
    if (!this.pending?.queued && this.restoredCheckpoint?.phase !== "continuing") return;
    this.pending = undefined;
    this.restoredCheckpoint = undefined;
    this.checkpoint("idle", false);
    if (this.switches) this.context?.ui.notify(`Relay completed: ${this.switches} switch${this.switches === 1 ? "" : "es"}`, "info");
    this.switches = 0;
  }

  pauseForInput(): void {
    if (this.wait.state !== "waiting") return;
    this.wait.pause();
    this.context?.ui.notify("Saved Relay task paused; use /relay wait resume", "warning");
  }

  async addProfile(label: string, access: string, refresh: string, signal?: AbortSignal): Promise<RelayProfile> {
    if (!label.trim() || !access || !refresh) throw new Error("Label and both tokens are required");
    const metadata = jwtMetadata(access);
    const credential = { access, refresh, expires: metadata.expires ?? 0, ...(metadata.accountId ? { accountId: metadata.accountId } : {}) };
    const duplicate = duplicateProfile(await this.vault.listProfiles(), credential);
    if (duplicate) throw new Error(`Account already exists as ${duplicate.label}`);
    const profile = await this.vault.add({ label: label.trim(), credential });
    try {
      const valid = await ensureValidToken(this.vault, profile, signal);
      const current = await this.vault.getProfile(profile.id) ?? { ...profile, credential: valid };
      await this.refreshProfile(current, true, signal);
      await this.log.write("profile-add", { profile: fingerprint(profile.id) });
      return await this.vault.getProfile(profile.id) ?? profile;
    } catch (error) {
      if (!(error instanceof UsageError && error.kind === "transient")) { await this.vault.remove(profile.id); throw error; }
      return profile;
    }
  }

  async refreshProfile(profile: RelayProfile, force = false, signal?: AbortSignal): Promise<void> {
    if (!force && isFresh(profile.quota)) return;
    const current = await this.vault.getProfile(profile.id);
    if (!current) return;
    const credential = await ensureValidToken(this.vault, current, signal);
    const quota = await fetchUsage(credential, signal);
    await this.vault.update(profile.id, (value) => {
      value.quota = quota;
      value.needsLogin = false;
      if (limitingRemaining(quota) === 0) value.exhaustedUntil = earliestFutureReset(value) ?? Date.now() + 60_000;
      else if ((value.exhaustedUntil ?? 0) <= Date.now()) delete value.exhaustedUntil;
    });
    await this.log.write("usage-result", { profile: fingerprint(profile.id), remaining: limitingRemaining(quota) });
  }

  async freshProfiles(): Promise<RelayProfile[]> {
    const profiles = (await this.vault.listProfiles()).filter((profile) => profile.enabled && !profile.needsLogin);
    await Promise.allSettled(profiles.map((profile) => this.refreshProfile(profile)));
    return this.vault.listProfiles();
  }

  overrides() { return { ...(this.pinnedProfileId ? { pinnedProfileId: this.pinnedProfileId } : {}), ...(this.prioritizedProfileId ? { prioritizedProfileId: this.prioritizedProfileId } : {}) }; }
  pin(id?: string): void { this.pinnedProfileId = id; this.updateStatus(); }
  prioritize(id?: string): void { this.prioritizedProfileId = id; this.updateStatus(); }
  activeId(): string | undefined { return this.activeProfileId; }

  cancelWait(): void {
    this.wait.cancel();
    this.pending = undefined;
    this.restoredCheckpoint = undefined;
    this.checkpoint("idle", false);
  }

  pauseWait(): void { if (this.wait.state === "waiting") this.wait.pause(); }

  async resumeWait(): Promise<boolean> {
    this.wait.resume();
    const profiles = await this.freshProfiles();
    const state = await this.vault.read();
    const selected = selectProfile(profiles, state.settings.policy, this.overrides(), Date.now(), new Set(), state.settings.priorityOrder).profile;
    if (selected) { this.queueResume(selected); return true; }
    void this.wait.wait(profiles).then(async (woke) => {
      if (!woke) return;
      const refreshed = await this.freshProfiles();
      const current = await this.vault.read();
      const next = selectProfile(refreshed, current.settings.policy, this.overrides(), Date.now(), new Set(), current.settings.priorityOrder).profile;
      if (next) this.queueResume(next);
    });
    return this.wait.state === "waiting";
  }

  overrideWait(profile: RelayProfile): void {
    this.pin(profile.id);
    if (this.pending || this.restoredCheckpoint?.phase === "paused" || this.restoredCheckpoint?.phase === "waiting" || this.restoredCheckpoint?.phase === "continuing") {
      this.wait.cancel();
      this.queueResume(profile);
    } else this.wait.override();
  }

  clearProfileReferences(id: string): void {
    if (this.pinnedProfileId === id) this.pinnedProfileId = undefined;
    if (this.prioritizedProfileId === id) this.prioritizedProfileId = undefined;
    if (this.activeProfileId === id) { this.activeProfileId = undefined; this.activeLabel = undefined; }
  }

  private dependencies(): RelayStreamDependencies {
    return {
      profiles: () => this.freshProfiles(),
      settings: async () => { const settings = (await this.vault.read()).settings; return { policy: settings.policy, priorityOrder: settings.priorityOrder }; },
      overrides: () => this.overrides(),
      prepare: (profile, signal) => ensureValidToken(this.vault, profile, signal),
      stream: (model, context, options) => this.base.streamSimple(model as Model<"openai-codex-responses">, context, options),
      failure: (profile, failure) => this.recordFailure(profile, failure),
      success: async (profile) => { await this.vault.update(profile.id, (value) => { value.lastSuccessAt = Date.now(); }); },
      selected: (profile, previous, selection) => this.recordSelection(profile, previous, selection),
      continuation: (details) => { this.pending = { ...details, queued: false }; },
      wait: async (profiles, signal) => (await this.vault.read()).settings.quotaWait && this.wait.wait(profiles, signal),
    };
  }

  private async recordSelection(profile: RelayProfile, previous: RelayProfile | undefined, selection: Selection): Promise<void> {
    if (selection.clearPin) this.pinnedProfileId = undefined;
    if (selection.consumePriority) this.prioritizedProfileId = undefined;
    await this.vault.update(profile.id, (value) => { value.lastUsedAt = Date.now(); });
    this.activeProfileId = profile.id;
    this.activeLabel = profile.label;
    if (previous && previous.id !== profile.id) { this.switches++; this.context?.ui.notify(`Relay: ${previous.label} -> ${profile.label}`, "info"); }
    this.updateStatus(profile);
    await this.log.write("select", { profile: fingerprint(profile.id), policy: selection.source });
  }

  private async recordFailure(profile: RelayProfile, failure: Failure): Promise<void> {
    if (failure.kind === "quota") {
      await this.refreshProfile(profile, true).catch(() => undefined);
      const current = await this.vault.getProfile(profile.id) ?? profile;
      const reset = earliestFutureReset(current) ?? Number.MAX_SAFE_INTEGER;
      await this.vault.update(profile.id, (value) => { value.exhaustedUntil = reset; });
    } else if (failure.kind === "rate-limit") {
      await this.vault.update(profile.id, (value) => { value.cooldownUntil = failure.retryAt ?? Date.now() + 30_000; });
    } else if (failure.kind === "auth") {
      await this.vault.update(profile.id, (value) => { value.needsLogin = true; });
      this.context?.ui.notify(`${profile.label} needs login`, "warning");
    }
    await this.log.write("failure", { profile: fingerprint(profile.id), kind: failure.kind });
  }

  private async hasUsableProfile(): Promise<boolean> { return (await this.vault.listProfiles()).some((profile) => profile.enabled && !profile.needsLogin); }

  private async migrate(): Promise<void> {
    const state = await this.vault.read();
    if (state.migratedNativeAuth || Object.keys(state.profiles).length) return;
    const credential: Credential | undefined = readStoredCredential("openai-codex");
    if (credential?.type === "oauth") {
      const metadata = jwtMetadata(credential.access);
      await this.vault.add({ label: "Default", credential: { access: credential.access, refresh: credential.refresh, expires: credential.expires, ...(metadata.accountId ? { accountId: metadata.accountId } : {}) } });
    }
    await this.vault.change((value) => { value.migratedNativeAuth = true; });
  }

  private queueResume(profile: RelayProfile): void {
    if (this.pending) return this.queueContinuation(this.pending, profile);
    const requestId = this.restoredCheckpoint?.requestId ?? "restored";
    this.checkpoint("continuing", true, requestId, profile.id);
    this.pi.sendMessage({ customType: "pi-relay-continuation", content: CONTINUE_PROMPT, display: false, details: { requestId, toProfileId: profile.id } }, { triggerTurn: true, deliverAs: "followUp" });
    this.restoredCheckpoint = { version: 1, phase: "continuing", continuationPending: true, requestId, activeProfileId: profile.id, updatedAt: Date.now() };
  }

  private queueContinuation(pending: Pending, next: RelayProfile): void {
    if (pending.queued) return;
    pending.queued = true;
    this.pinnedProfileId = next.id;
    this.checkpoint("continuing", true, pending.requestId, next.id);
    this.pi.sendMessage({ customType: "pi-relay-continuation", content: CONTINUE_PROMPT, display: false, details: { requestId: pending.requestId, fromProfileId: pending.profile.id, toProfileId: next.id } }, { triggerTurn: true, deliverAs: "followUp" });
    void this.log.write("continuation-queued", { request: pending.requestId, profile: fingerprint(next.id) });
  }

  private checkpoint(phase: SessionRelayState["phase"], continuationPending: boolean, requestId?: string, profileId?: string): void {
    const state = { version: 1, phase, continuationPending, ...(requestId ? { requestId } : {}), ...(profileId ? { activeProfileId: profileId } : {}), updatedAt: Date.now() } satisfies SessionRelayState;
    this.restoredCheckpoint = state;
    this.pi.appendEntry("pi-relay-state", state);
  }

  private waitChanged(state: "idle" | "waiting" | "paused", wake?: { profile: RelayProfile; at: number }): void {
    if (state === "waiting" && wake) {
      this.checkpoint("waiting", !!this.pending, this.pending?.requestId, wake.profile.id);
      this.context?.ui.setStatus("pi-relay", `Relay: QUOTA WAIT | ${wake.profile.label} ${formatRelative(wake.at)}`);
      this.context?.ui.setWidget("pi-relay", ["QUOTA WAIT", `Resume: ${wake.profile.label} ${formatRelative(wake.at)}`, "Controls: /relay wait cancel | pause | resume"]);
      this.context?.ui.notify("Relay entered Quota Wait", "warning");
    } else if (state === "paused") {
      this.checkpoint("paused", !!this.pending, this.pending?.requestId);
      this.context?.ui.setStatus("pi-relay", "Relay: PAUSED | /relay wait resume");
      this.context?.ui.setWidget("pi-relay", undefined);
    } else {
      this.context?.ui.setWidget("pi-relay", undefined);
      this.updateStatus();
    }
  }

  private updateStatus(profile?: RelayProfile): void {
    const label = profile?.label ?? this.activeLabel ?? "no account";
    this.context?.ui.setStatus("pi-relay", `Relay: ${label}${this.pinnedProfileId ? " | pinned" : ""}`);
  }
}

export const relayPaths = (agentDir: string) => ({ state: `${agentDir}/pi-relay/state.json`, log: `${agentDir}/pi-relay/pi-relay.log` });
const formatRelative = (at: number) => { const minutes = Math.max(1, Math.ceil((at - Date.now()) / 60_000)); return `in ${minutes}m`; };
