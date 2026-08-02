# Pi Relay: Implementation Plan

Status: architecture and implementation plan
Target: Pi 0.83.0
Initial provider: OpenAI Codex through `openai-codex`
Primary goal: uninterrupted long-running Pi tasks across multiple Codex accounts without modifying Pi core

## 1. Executive decision

Build Pi Relay as a standalone Pi extension. Do not fork Pi and do not create a second agent runtime.

The recommended architecture is a full provider override registered under the existing literal provider ID `openai-codex`. The extension constructs Pi's native Codex provider, retains its model catalog and transport, replaces only authentication selection and request orchestration, and delegates every actual Codex request back to the native provider with the selected account's access token.

This is preferable to provider aliases for v1 because it:

- Keeps the user's selected provider and model unchanged.
- Avoids duplicating every Codex model once per account.
- Avoids writing the active profile into Pi's single-credential `auth.json` before each request.
- Allows pre-output quota failures to retry the exact same model request transparently.
- Makes preflight selection a normal part of every Codex request.
- Gives the extension one place to enforce retry bounds, quota waiting, logging, and account selection.
- Leaves a clean provider-adapter seam for future Anthropic or other providers.

Use Pi's native session continuation only when a failure occurs after meaningful model output has already been emitted. At that point, replaying the same request could duplicate text or side effects. Instead, allow the partial assistant error to finish, select the next account, and queue a hidden follow-up instruction that tells the agent to continue from the existing session state.

The implementation therefore has two recovery paths:

1. Before meaningful output: switch credentials and retry the same request inside the provider wrapper.
2. After meaningful output: finish the failed turn, then queue a hidden continuation in the same Pi session.

This satisfies the practical behavior of manually logging into another account and typing `continue`, while avoiding a Pi core change.

## 2. Research conclusions that drive the design

### 2.1 Pi extension boundary is sufficient

Pi 0.83.0 permits extensions to register a complete `Provider`, including custom authentication and `streamSimple` behavior. The relevant source is:

- `packages/coding-agent/src/core/extensions/types.ts:1348-1401`
- `packages/coding-agent/src/core/extensions/loader.ts:374-386`
- `packages/coding-agent/src/core/extensions/runner.ts:350-402`

Pi resolves request authentication and then dispatches to the registered provider's stream implementation:

- `packages/coding-agent/src/core/model-runtime.ts:440-498`

A full provider registered with ID `openai-codex` replaces the built-in provider for requests while preserving that public provider identity.

### 2.2 Pi stores one credential per provider ID

Pi's native credential shape is `Record<providerId, Credential>`, so it does not natively hold multiple OAuth accounts under one provider ID:

- `packages/ai/src/auth/types.ts:13-36`
- `packages/coding-agent/src/core/auth-storage.ts`

Provider aliases can work around that limitation, and several existing extensions use them. Pi Relay does not need aliases because it owns a small account vault and supplies the selected token directly to the native Codex stream.

### 2.3 Rewriting `auth.json` is not the correct runtime switch mechanism

The uploaded `pi-auth` extension has a strong vault implementation, but its activation mechanism mirrors one selected profile into Pi's `auth.json`. Pi keeps auth state in memory, and extension reload does not represent an auth hot-reload contract. Pi Relay should reuse the vault's locking and atomic-write ideas, not its active-profile mirroring approach.

Useful uploaded `pi-auth` source:

- `src/vault.ts`: lock directory, stale-lock recovery, corrupt-file recovery, atomic temporary-file write, fsync, rename, mode `0600`, directory mode `0700`, generation-based compare-and-swap refresh commit.
- `src/manager.ts`: profile status and refresh orchestration.
- `src/auth-mirror.ts`: evidence of the mirror approach that Pi Relay should avoid.

### 2.4 Codex quota is directly queryable per credential

The uploaded `pi-usage` implementation and other Codex extensions call:

```text
https://chatgpt.com/backend-api/wham/usage
```

with:

```text
Authorization: Bearer <access token>
ChatGPT-Account-Id: <account id>
```

The response exposes primary and secondary rate-limit windows, including used percentage and reset epoch. Pi Relay should adapt this code into a function that accepts an explicit account credential instead of reading only the currently active credential.

Relevant uploaded source:

- `pi-usage-main/src/providers/codex.ts`
- `pi-usage-main/src/cache.ts`
- `pi-auth-main/src/usage.ts`

### 2.5 Pi stops before executing tools on an assistant error

Pi's agent loop streams the assistant message, then immediately ends the turn when the stop reason is `error` or `aborted`. It does not execute tool calls from an errored assistant message:

- `packages/agent/src/agent-loop.ts:192-203`

This removes the need for a separate tool-execution ledger in v1. Pi already stores successfully completed tool calls and tool results in session history. The extension must still avoid replaying a request after meaningful output, but it does not need to intercept every tool or invent a second transaction system.

### 2.6 Pi supports session-level continuation from `agent_end`

Pi exposes `sendMessage`, including hidden custom messages, and lets an extension queue a follow-up while a run is ending:

- `packages/coding-agent/src/core/extensions/types.ts:1285-1301`
- `packages/coding-agent/src/core/agent-session.ts:1048-1094`

After `agent_end`, Pi checks queued messages and invokes `agent.continue()`. Therefore, Pi Relay can queue a hidden continuation message after a partial-output quota failure without changing Pi core.

### 2.7 Existing extensions prove the main seams but also show what to avoid

Research included these projects:

- `kim0/pi-multicodex`
- `victor-software-house/pi-multicodex`
- `hjanuschka/pi-multi-pass`
- `MasuRii/pi-multi-auth`
- `khanhicetea/pi-multi-codex`
- `Sarrius/pi-multi-account`
- `MateuszJuszczyk/omp-codex-account`

Useful patterns to retain:

- Wrap the native provider instead of reimplementing the Codex protocol.
- Pass an account token through `SimpleStreamOptions.apiKey`.
- Refresh stale tokens before request dispatch.
- Query `wham/usage` per account.
- Exclude an account after confirmed quota exhaustion.
- Keep a request-local attempted-account set.
- Display the active account and quota in Pi's TUI.
- Queue a continuation only when transparent replay is no longer safe.

Patterns to reject for v1 under YAGNI:

- Arbitrary pool graphs and fallback chains.
- Project-level account affinity.
- Health scoring formulas.
- General circuit-breaker frameworks.
- User-provided JavaScript selection strategies.
- Many provider-specific abstractions before a second provider exists.
- Full custom footer replacement.
- Separate tool-call replay ledgers.
- Import/export UI.
- Encryption or vault locking screens.
- Large configuration schemas with dozens of tuning fields.

One concrete defect to avoid appears in existing stream wrappers: some set `forwardedAny = true` for every non-error event. Since the protocol emits a `start` event before output, that can incorrectly disable a safe pre-output retry. Pi Relay must track meaningful output, not merely whether any protocol event was received.

## 3. Product behavior

### 3.1 Normal startup

When Pi loads the extension:

1. Open or create the Pi Relay vault.
2. If the vault has no Codex profiles, inspect Pi's existing `openai-codex` credential once.
3. If that credential is OAuth, copy it into the vault as `Default` and record that migration.
4. Construct Pi's native Codex provider with `openaiCodexProvider()`.
5. Register the Pi Relay wrapper under the same provider ID, `openai-codex`.
6. Register one command family, `/relay`.
7. Restore session-local Relay state from custom session entries.
8. Refresh stale quota snapshots without blocking startup longer than necessary.
9. Show a compact status entry in Pi's footer.

### 3.2 Adding an account

The primary user path is:

```text
/relay add
```

The command should use Pi's native login interaction when possible because it supports masked secret prompts. The flow asks for:

1. Label.
2. Access token, secret input.
3. Refresh token, secret input.

Then it:

1. Parses the access-token JWT locally.
2. Extracts the token expiration time.
3. Extracts `chatgpt_account_id` from the Codex JWT claim.
4. Rejects an exact duplicate account ID unless the user is replacing that profile.
5. Calls the usage endpoint to validate the credential.
6. If the access token is expired but the refresh token is present, performs one refresh and validates the result.
7. Writes the profile atomically to the vault.
8. Refreshes quota.
9. Shows the profile in the account dashboard.

No token may appear in status text, notifications, logs, errors, or command output.

### 3.3 Account dashboard

`/relay` and `/relay status` should open an interactive account view in TUI mode and print compact lines in non-interactive modes.

Example:

```text
PI RELAY

* Personal       ACTIVE       5h 42% left / 38m     7d 81% left / 3d
  School         AVAILABLE    5h 81% left / 2h14m   7d 94% left / 5d
  Backup         AVAILABLE    5h 100% left / 4h     7d 100% left / 7d
  Old account    DISABLED

Next: Personal - shortest limiting reset
Pool: 5h 80.8% | 7d 91.7% | effective 80.8%
Policy: Smart Reset
Quota Wait: on
```

The dashboard must distinguish:

- Active: used by the current or latest request.
- Next: current selector prediction, not a guarantee.
- Pinned: chosen with `use` for the next safe request boundary.
- Prioritized: preferred at the next failover.
- Skipped: temporarily excluded.
- Disabled: persistently excluded.
- Exhausted: confirmed zero quota until a known reset.
- Cooldown: provider-directed retry delay, not quota exhaustion.
- Needs login: refresh token invalid or credential rejected.
- Unknown: usage could not be checked; still handled conservatively.

### 3.4 Automatic preflight selection

Every Codex request runs a light preflight:

1. Load current account state from memory.
2. Clear expired skip, cooldown, and exhausted timestamps.
3. Refresh quota only for missing or stale candidates.
4. Apply a pending manual `use` pin if it is still eligible.
5. Otherwise apply the configured selection policy.
6. Ensure the chosen token is valid.
7. Update status before opening the stream.
8. Delegate to Pi's native Codex provider.

A preflight account change should be visible but not noisy:

```text
Relay: Personal -> School | preflight: earlier reset
```

Use a brief `ctx.ui.notify()` only when the account actually changes. Keep the persistent `setStatus()` line current for all requests.

### 3.5 Failover before meaningful output

If a request fails with confirmed quota exhaustion before meaningful output:

1. Suppress the terminal error event from the outer Pi agent stream.
2. Force-refresh quota for the failed account.
3. Mark it exhausted until the reported reset.
4. Add it to the current request's exclusion set.
5. Select the next eligible account.
6. Refresh its token if needed.
7. Retry the same model and `Context` using the native provider.
8. Forward only one outer `start` event.
9. Continue until success, all accounts are unavailable, cancellation occurs, or three full passes are reached.

This retry must not create a synthetic conversation message because the outer Pi agent has not yet received meaningful assistant content.

### 3.6 Failover after meaningful output

Meaningful output begins with any of:

- `text_start`, `text_delta`, or non-empty text.
- `thinking_start`, `thinking_delta`, or non-empty reasoning.
- `toolcall_start`, `toolcall_delta`, or `toolcall_end`.

The protocol `start` event alone is not meaningful output.

If a quota error occurs after meaningful output:

1. Forward the error so Pi records the partial assistant message.
2. Save a minimal Relay session checkpoint.
3. On `agent_end`, confirm the terminal error belongs to the current Relay request.
4. Select the next eligible account or enter Quota Wait.
5. Queue a hidden custom follow-up message:

```text
Resume the existing task from the current session state. Inspect prior assistant text, completed tool calls, and tool results. Do not repeat completed side effects. Continue with the next unfinished step.
```

6. Set `display: false`, `triggerTurn: true`, and `deliverAs: "followUp"`.
7. Let Pi call `agent.continue()` with the full existing conversation.

### 3.7 All accounts exhausted: Quota Wait

Quota Wait is enabled by default.

When every enabled account is unavailable because of known quota windows:

1. Compute the earliest reliable reset across all enabled profiles.
2. Persist a wait checkpoint in the Pi session.
3. Display an obvious persistent widget and status line.
4. Sleep until a small grace interval after the reset.
5. Force-refresh that account's usage.
6. If it is available, resume immediately.
7. If it is still unavailable, recompute the next wake time.
8. Continue until the task completes, the user cancels, or a non-quota terminal error occurs.

Example persistent TUI state:

```text
QUOTA WAIT
Resume: Personal in 37m
Task: waiting to continue the interrupted turn
Controls: /relay wait cancel | pause | resume | override <account>
```

Do not poll every few seconds. Use the provider's reset timestamp and one timer. If the timestamp is stale or unavailable, use a conservative fallback check interval with capped exponential delay, but do not label it as an exact reset.

### 3.8 Manual controls

Use exactly these controls:

- `use <account>`: pin this account for the next safe request boundary. It remains active until exhausted, invalid, disabled, or replaced by another explicit `use`.
- `skip <account>`: exclude this account until its earliest current quota reset. If no reset is known, exclude it until manually cleared or Pi restarts; show that limitation.
- `disable <account>`: persistently remove it from automatic selection.
- `enable <account>`: clear disabled and skipped state and make it eligible again.
- `prioritize <account>`: one-shot preference for the next failover or preflight selection; clear after it is consumed or proves ineligible.
- `refresh [account|all]`: force a usage and health check.
- `policy <smart-reset|most-available|priority-order>`: select one of exactly three policies.
- `wait cancel|pause|resume|override`: control Quota Wait.
- `remove <account>`: delete a profile after confirmation.
- `rename <account> <label>`: change only the user-facing label.

Do not add `rotate now`; `use` and `prioritize` already cover the meaningful cases.

## 4. Non-negotiable engineering principles

### 4.1 YAGNI

A feature enters v1 only when it is required by the stated workflow or by correctness, security, recovery, or testability.

Explicitly defer:

- Arbitrary account pools.
- Cross-provider failover UI.
- Browser OAuth onboarding.
- Project-specific policies.
- Account health scores.
- Circuit breaker frameworks.
- Desktop notifications.
- Import/export.
- Encrypted vaults and unlock prompts.
- Custom user strategy scripts.
- Telemetry.
- Remote synchronization.
- Web dashboard.
- Exact token-level continuation of a dead network stream.

### 4.2 Prefer direct code

Use one-line transformations when they remain readable. Prefer small pure functions over classes. Introduce a class only where mutable ownership is real, such as the vault or wait controller.

Examples:

```ts
const remaining = (used?: number) => used == null ? undefined : Math.max(0, 100 - used);
```

```ts
const eligible = accounts.filter((account) => isEligible(account, now));
```

Do not create generic repositories, service locators, dependency injection containers, event-sourcing systems, or command buses.

### 4.3 One source of truth

- Pi session history is the source of truth for conversation and completed tools.
- Pi Relay vault is the source of truth for profiles, tokens, quota snapshots, and global settings.
- Pi custom session entries are the source of truth for a pending Relay continuation or Quota Wait state.
- In-memory request state exists only for the active stream and can be rebuilt from the above after a restart.

Do not duplicate full conversation history in the Relay vault.

### 4.4 Minimal comments

Comments are allowed only for non-obvious invariants:

- Why `start` is not considered meaningful output.
- Why retries stop after meaningful output.
- Why refresh commit uses a generation check.
- Why wait wake-up includes a reset grace interval.
- Why logs hash account identifiers and never include prompts or tokens.

Do not add file banners, prose above obvious functions, or comments that restate the code.

### 4.5 Minimal documentation

The README should contain only:

1. What Pi Relay does.
2. Installation.
3. Add-account command.
4. Short command table.
5. Data location and plaintext-token warning.
6. Exact recovery behavior and limitation.
7. Development commands.

All architecture detail belongs in this plan and tests, not in the README.

## 5. Detailed architecture

### 5.1 Extension entry point

`index.ts` should perform orchestration only:

1. Resolve `getAgentDir()`.
2. Create the vault and logger.
3. Run one-time native-auth migration when appropriate.
4. Create the Codex adapter.
5. Construct the Relay controller.
6. Register the full `openai-codex` provider override.
7. Register `/relay`.
8. Register lifecycle handlers.

Keep the file small. It should not contain selection algorithms, JWT parsing, usage response parsing, or stream-loop internals.

Suggested shape:

```ts
export default async function relay(pi: ExtensionAPI) {
  const paths = relayPaths(getAgentDir());
  const vault = new Vault(paths.state);
  const log = new RelayLog(paths.log);
  const base = openaiCodexProvider();
  const controller = await RelayController.create({ pi, base, vault, log });

  pi.registerProvider(controller.provider());
  registerRelayCommand(pi, controller);
  registerRelayHooks(pi, controller);
}
```

Do not create a framework around this function.

### 5.2 Native provider wrapper

Construct the native provider directly:

```ts
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
```

Then create a replacement provider with:

- `id`: unchanged, `openai-codex`.
- `name`: unchanged or `OpenAI Codex (Pi Relay)`.
- `baseUrl`: native value.
- `getModels`: delegate to native provider.
- `refreshModels`: delegate if present.
- `filterModels`: delegate if present.
- `stream`: delegate through a minimal wrapper or route to the same account-selection core.
- `streamSimple`: Pi Relay stream wrapper.
- `auth`: a Pi Relay-managed API-key auth shim.

The provider auth shim exists only to make Pi consider `openai-codex` configured and to expose masked onboarding through `/login`. It must never return a real account token to Pi's normal auth storage.

Suggested behavior:

```ts
const auth: ProviderAuth = {
  apiKey: {
    name: "Pi Relay Codex account",
    login: (interaction) => addProfileThroughLogin(interaction, vault, adapter),
    check: async () => vault.hasUsableProfile() ? { type: "api_key", source: "Pi Relay" } : undefined,
    resolve: async () => vault.hasUsableProfile()
      ? { auth: { apiKey: "pi-relay-managed" }, source: "Pi Relay" }
      : undefined,
  },
};
```

The wrapper ignores `options.apiKey` from this shim and injects the selected profile token when delegating to the native provider.

Why this is better than updating Pi auth on every switch:

- No race between disk writes and Pi's in-memory credential store.
- No need to call reload.
- No provider/model change event for account rotation.
- No duplicate provider aliases.
- No stale active credential left behind after a crash.

### 5.3 Compatibility adapter

Pi internals can change. Put all Pi-version-sensitive operations in one file, `src/pi.ts`:

- Construct native Codex provider.
- Register the full provider.
- Read an existing native credential for one-time migration.
- Send a hidden continuation.
- Read current session identity.
- Set status, widget, and notifications.

The rest of the code should depend on a narrow local interface, not on scattered Pi imports.

Example:

```ts
interface PiBridge {
  sendContinuation(details: ContinuationDetails): void;
  appendCheckpoint(state: SessionRelayState): void;
  status(text?: string): void;
  waitWidget(lines?: string[]): void;
  notify(text: string, level?: "info" | "warning" | "error"): void;
}
```

Do not add adapters for hypothetical Pi versions. Support Pi 0.83.0 first, with feature detection only where it costs a few lines.

## 6. Data model

### 6.1 Global vault schema

Use one versioned JSON file for v1:

```text
~/.pi/agent/pi-relay/state.json
```

Suggested schema:

```ts
type RelayState = {
  version: 1;
  settings: {
    policy: "smart-reset" | "most-available" | "priority-order";
    quotaWait: boolean;
    priorityOrder: string[];
  };
  profiles: Record<string, RelayProfile>;
};

type RelayProfile = {
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
```

Keep one-shot `use` and `prioritize` overrides session-local, not global, unless the user explicitly asks for persistence later. A persistent disabled flag and priority order are global because those are configuration choices.

Do not persist derived display strings. Persist timestamps and percentages, then format at render time.

### 6.2 Quota snapshot

```ts
type QuotaWindow = {
  usedPercent?: number;
  resetAt?: number;
  windowSeconds?: number;
};

type CodexQuotaSnapshot = {
  primary?: QuotaWindow;
  secondary?: QuotaWindow;
  fetchedAt: number;
  error?: "auth" | "network" | "invalid-response";
};
```

Helpers:

```ts
const remaining = (window?: QuotaWindow) =>
  window?.usedPercent == null ? undefined : Math.max(0, 100 - window.usedPercent);

const limitingRemaining = (quota?: CodexQuotaSnapshot) =>
  minDefined(remaining(quota?.primary), remaining(quota?.secondary));
```

Use the provider's actual window durations for labels. Do not hard-code `5h` or `7d` as semantic identities; use `primary` and `secondary` internally and format duration labels from `windowSeconds`.

### 6.3 Session state

Persist only transition checkpoints with `pi.appendEntry()`:

```ts
type SessionRelayState = {
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
```

Append entries only when the state crosses a recovery boundary:

- Entering Quota Wait.
- Pausing Quota Wait.
- Cancelling Quota Wait.
- Scheduling a continuation.
- Completing a continuation chain.

Do not append an entry for every status refresh or token delta.

### 6.4 Active request state

Keep transient state in memory:

```ts
type RequestRun = {
  id: string;
  startedAt: number;
  attempted: Set<string>;
  pass: number;
  meaningfulOutput: boolean;
  outerStartSent: boolean;
  activeProfileId?: string;
  switched: number;
  waitedMs: number;
  continuationRequired: boolean;
};
```

This state is discarded after success or terminal failure. A restart cannot resume the exact request object, so restart recovery uses the persisted session continuation path.

## 7. Vault implementation

### 7.1 Reuse the proven `pi-auth` persistence pattern

Adapt the uploaded `pi-auth/src/vault.ts` rather than adding a database or dependency.

Required properties:

- Parent directory created with mode `0700`.
- State file written with mode `0600`.
- Lock directory acquired with `mkdir`.
- Stale locks removed after a conservative timeout.
- Writes go to a unique temporary file.
- Temporary file is opened with exclusive create.
- File contents are flushed with `fsync`.
- Temporary file is renamed atomically over the state file.
- Directory is flushed after rename.
- Invalid JSON is moved to `.corrupt` and never silently overwritten in place.

### 7.2 Generation-based refresh commit

Each profile has a `generation` integer. Token refresh flow:

1. Read profile and generation under lock.
2. Release lock before network call.
3. Refresh using the captured refresh token.
4. Reacquire lock.
5. Commit only if the generation is unchanged.
6. If changed, discard the network result and read the newer credential.

This prevents an older refresh response from overwriting a newer login or refresh performed by another Pi process.

Pseudocode:

```ts
const snapshot = await vault.readProfile(id);
const refreshed = await oauth.refresh(toOAuth(snapshot.credential));
const committed = await vault.commitRefresh(id, snapshot.generation, refreshed);
return committed ? refreshed : vault.readProfile(id).credential;
```

### 7.3 In-process refresh deduplication

Also maintain:

```ts
const refreshes = new Map<string, Promise<Credential>>();
```

If two requests need the same profile refresh in one process, return the same promise. Remove it in `finally`.

This is a small, justified optimization because concurrent status refresh and request preflight can otherwise exchange the same refresh token twice.

### 7.4 Plaintext storage statement

The vault stores OAuth tokens as plaintext JSON protected by filesystem permissions. This is consistent with Pi's native auth storage and the uploaded `pi-auth` design.

Do not claim encryption. The concise README must say:

```text
Pi Relay stores OAuth tokens in ~/.pi/agent/pi-relay/state.json with owner-only permissions. Anyone who can read files as your OS user can read these tokens.
```

No vault password or security lock in v1.

## 8. Credential onboarding and lifecycle

### 8.1 One-time migration

Before registering the replacement provider:

1. If the Relay vault already contains a Codex profile, do nothing.
2. Call `readStoredCredential("openai-codex")`.
3. If it is an OAuth credential with access and refresh fields, add it as `Default`.
4. Derive account ID and expiration from the token when missing.
5. Validate or refresh it asynchronously.
6. Record a migration marker in the vault so the same credential is not repeatedly imported.

Do not delete the original Pi credential automatically. Once the Relay provider login shim is used, Pi may replace it with the harmless Relay marker. This migration is a bootstrap convenience, not a general import/export feature.

### 8.2 Paste-token login flow

Implement profile addition as a custom API-key login interaction attached to the provider. It should use `AuthPrompt` types:

- Label: `text`.
- Access token: `secret`.
- Refresh token: `secret`.

Return a harmless marker credential after the vault write:

```ts
return { type: "api_key", key: "pi-relay-managed" };
```

The marker is not a real token. `resolve()` returns the same marker only when the vault has an enabled profile.

If `/relay add` cannot directly invoke the login interaction through the public extension API, use the minimal supported path:

1. Inform the user that the next screen is Pi's secure login prompt.
2. Put `/login openai-codex` in the editor with `ctx.ui.setEditorText()` or provide a one-line instruction.
3. Keep all actual token entry in Pi's native secret prompt.

Do not collect tokens through ordinary `ctx.ui.input()`, because it is not documented as masked.

### 8.3 JWT parsing

Parse JWT payload locally without signature verification for metadata only:

- `exp` sets `expires`.
- `https://api.openai.com/auth.chatgpt_account_id` sets `accountId`.
- Optional email-like claims may suggest a default label, but user-provided label remains authoritative.

Do not treat decoded metadata as proof of authenticity. Actual validation comes from token refresh and the usage endpoint.

### 8.4 Duplicate detection

Reject profiles with the same non-empty `accountId` unless the operation is an explicit replacement.

Fallback duplicate checks:

- Same refresh-token fingerprint.
- Same access-token fingerprint only when no account ID exists.

Store only a short SHA-256 fingerprint for diagnostics; never log or display token substrings.

### 8.5 Token validation

On add:

1. If access token expires more than five minutes in the future, call usage endpoint.
2. If expired or nearly expired, call native Codex OAuth `refresh()` first.
3. If refresh returns a rotated refresh token, store it.
4. If `invalid_grant` or equivalent occurs, reject the profile as invalid.
5. If usage call fails only from network error, allow the profile with `quota: unknown` and show a warning.
6. If usage call returns 401 or 403, reject or mark `needsLogin` based on whether refresh was already attempted.

### 8.6 Ongoing refresh

Before a request, refresh when:

```text
expires <= now + 5 minutes
```

After a refresh failure:

- `invalid_grant`, revoked token, or repeated 401: set `needsLogin` and rotate.
- Network error: do not set `needsLogin`; classify as transient and let request-level handling decide.
- User abort: propagate abort without changing account health.

## 9. Quota client

### 9.1 Codex adapter API

Keep the provider-specific seam small:

```ts
interface ProviderAdapter {
  id: string;
  validate(profile: RelayProfile, signal?: AbortSignal): Promise<ValidationResult>;
  refresh(profile: RelayProfile, signal?: AbortSignal): Promise<OAuthCredential>;
  usage(profile: RelayProfile, signal?: AbortSignal): Promise<QuotaSnapshot>;
  classify(error: AssistantMessage | unknown): Failure;
  stream(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
    profile: RelayProfile,
  ): AssistantMessageEventStream;
}
```

Implement only `CodexAdapter` in v1. Do not build a runtime registry UI yet. A simple `Map<string, ProviderAdapter>` is enough if the controller benefits from it.

### 9.2 Usage request

Adapt `pi-usage`:

```ts
await fetch("https://chatgpt.com/backend-api/wham/usage", {
  headers: {
    Authorization: `Bearer ${access}`,
    Accept: "application/json",
    ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
  },
  signal,
});
```

Requirements:

- Ten-second timeout.
- Linked abort signal.
- Strict response shape checks.
- Preserve `used_percent`, `reset_at`, and `limit_window_seconds`.
- Convert reset epoch seconds to milliseconds once.
- Do not infer reset cadence from historical behavior.

### 9.3 Cache policy

Use a 60-second TTL for normal dashboard and preflight checks.

Force refresh on:

- User command `refresh`.
- Confirmed quota error.
- Wake from Quota Wait.
- Newly added or refreshed credential.
- A cached snapshot whose reset time has passed.

Do not run a constant global polling loop. Refresh on demand and optionally schedule one low-frequency status update only while the TUI is active.

### 9.4 Parallel refresh

For v1, use `Promise.allSettled()` across enabled profiles. Typical account pools are small, and a concurrency limiter adds code without evidence of need.

If a user later has a very large pool and the endpoint objects, add a limit only after measuring it.

### 9.5 Pooled usage

For equal-capacity Codex accounts:

```ts
shortPool = average(remaining(primary) for profiles with fresh data);
longPool = average(remaining(secondary) for profiles with fresh data);
effectivePool = min(shortPool, longPool);
```

Display coverage:

```text
Pool: 5h 75% | 7d 91% | effective 75% | 4/4 fresh
```

If profiles have unknown data:

```text
Pool estimate: 5h 75% | 3/4 measured
```

Do not silently count unknown profiles as zero or one hundred.

For future mixed-provider pools, percentages are not directly comparable unless capacity weights are known. Leave weighting out of v1 and document the future requirement in the adapter contract.

## 10. Selection engine

### 10.1 Eligibility filter

A profile is eligible only when all are true:

- `enabled` is true.
- `needsLogin` is not true.
- It is not in the request-local attempted set for the current pass.
- `skippedUntil` is absent or in the past.
- `cooldownUntil` is absent or in the past.
- `exhaustedUntil` is absent or in the past.
- Fresh quota does not show zero effective remaining.
- It has access and refresh credentials.

Unknown quota does not automatically make an account ineligible. Rank it below accounts with known usable quota and attempt it only when needed.

### 10.2 Manual override order

Selection precedence:

1. Explicit `use` pin, if eligible.
2. One-shot `prioritize`, if eligible.
3. Configured policy.

If a pin is ineligible:

- Clear it only for exhaustion, auth invalidation, disable, or removal.
- Keep it during a short provider-directed cooldown unless another account must be used to continue the current task.
- Tell the user when the pin is cleared and why.

### 10.3 Policy 1: Smart Reset

Default policy.

Goal: consume quota that will reset soon, while avoiding accounts already close to a hard limit when another usable choice exists.

Recommended deterministic ranking:

1. Known usable quota before unknown quota.
2. Earliest reset of the currently limiting window.
3. Lower effective remaining percentage, so expiring quota is consumed before fresher quota.
4. Oldest `lastUsedAt`.
5. Stable configured order.

Define the limiting window as the window with the smaller remaining percentage. Its reset time is the primary reset key.

Example:

```ts
const rankSmart = (profile: RelayProfile) => [
  quotaKnown(profile) ? 0 : 1,
  limitingResetAt(profile) ?? Number.MAX_SAFE_INTEGER,
  limitingRemaining(profile) ?? 101,
  profile.lastUsedAt ?? 0,
  profile.order,
];
```

Use a small tuple comparator. Do not implement a weighted score.

### 10.4 Policy 2: Most Available

Rank by:

1. Highest effective remaining quota.
2. Highest primary remaining quota.
3. Earliest limiting reset.
4. Oldest last use.
5. Stable configured order.

This policy is useful when the user values the account most likely to finish a large request without another switch.

### 10.5 Policy 3: Priority Order

Use the user's explicit order and choose the first eligible profile. Unknown quota is allowed after known-exhausted accounts are filtered.

This policy is the simplest predictable mode and is also the basis for future cross-provider fallback.

### 10.6 Predicted next account

The dashboard computes `next` using the same selector with:

- The active account excluded only if it is currently exhausted or the user asks for failover prediction.
- No mutation of `lastUsedAt`.
- No usage refresh unless the current cache is stale.

Label the value `Next predicted`, because request-time quota or auth can change.

### 10.7 Skip semantics

`skip` means temporary user-directed exclusion, not health failure.

Set:

```ts
skippedUntil = earliestFutureReset(profile.quota) ?? Number.MAX_SAFE_INTEGER;
```

When no reset is known, display `Skipped until cleared` and let `enable`, `use`, or a dedicated repeat of `skip` clear it. Do not invent an arbitrary duration.

## 11. Failure classification

### 11.1 Failure union

Use a small discriminated union:

```ts
type Failure =
  | { kind: "quota"; resetAt?: number; message: string }
  | { kind: "rate-limit"; retryAt?: number; message: string }
  | { kind: "auth"; recoverable: boolean; message: string }
  | { kind: "transient"; message: string }
  | { kind: "request"; message: string }
  | { kind: "model"; message: string }
  | { kind: "aborted"; message: string }
  | { kind: "unknown"; message: string };
```

### 11.2 Confirmed quota

Rotate for strict Codex indicators such as:

- Structured provider code `usage_limit_reached`.
- `usage_not_included`.
- `insufficient_quota`.
- Friendly Pi message containing `You have hit your ChatGPT usage limit`.
- A forced usage refresh showing effective remaining quota at or below zero.

A bare HTTP 429 is not enough to mark quota exhausted when the usage endpoint still shows capacity.

### 11.3 Provider-directed rate limit

For generic 429 with remaining quota:

- Parse `Retry-After` or provider retry metadata when available.
- Set `cooldownUntil` only for that profile.
- Rotate before meaningful output.
- Do not call it exhausted.
- Clear the cooldown automatically at expiry.

If no retry time is available, use one short fallback delay, such as 30 seconds. Keep this constant internal rather than exposing a setting in v1.

### 11.4 Authentication failure

Cases:

- Expired access token with valid refresh token: refresh and retry same profile once.
- 401 after refresh: mark `needsLogin` and rotate.
- `invalid_grant` during refresh: mark `needsLogin` and rotate.
- 403 from usage or stream: distinguish quota/plan response from auth or permission message.
- Missing account ID: derive from the latest access token before declaring failure.

Never retry the same refresh endlessly.

### 11.5 Transient failure

Network reset, DNS failure, timeout, 500, 502, 503, and WebSocket closure are transient unless the provider includes a quota verdict.

Preferred behavior:

- Let Pi/native provider retry behavior handle the transient condition.
- Do not rotate accounts merely because one network connection failed.
- If the native stream returns a terminal transient error before output, allow at most one same-account retry only if Pi has not already retried it. To avoid fighting Pi internals, v1 should usually surface the transient error and not add a second retry layer.

### 11.6 Request and model errors

Invalid arguments, unsupported model, permission mismatch, context overflow, malformed tool schema, and content errors should surface immediately. Switching accounts is unlikely to help and can conceal the real problem.

### 11.7 Aborts

User abort, session switch, process shutdown, or linked abort signal:

- Stop immediately.
- Do not rotate.
- Do not mark an account unhealthy.
- Cancel Quota Wait timer.
- Clear any continuation generated solely for the aborted request.

## 12. Stream wrapper

### 12.1 Outer event stream

Use Pi AI's `createAssistantMessageEventStream()` and run one async producer.

Pseudocode:

```ts
function streamSimple(model, context, options) {
  const outer = createAssistantMessageEventStream();
  void runRelayStream({ outer, model, context, options }).catch((error) => {
    outer.push(toErrorEvent(model, error));
    outer.end();
  });
  return outer;
}
```

All exits must end the outer stream exactly once.

### 12.2 Request algorithm

```text
create request state
preflight eligible profiles
for pass 1..3
  for each selected profile not attempted in this pass
    validate/refresh credential
    start native stream with selected access token
    forward outer start once
    consume events
      if meaningful event: mark meaningfulOutput
      if done: record success and finish
      if quota/auth error before meaningful output:
        classify, update profile, exclude, retry
      if error after meaningful output:
        mark continuationRequired, forward error, finish
      otherwise forward error and finish
  if no eligible account:
    enter quota wait or fail
finish with bounded terminal error
```

The selection engine should choose one profile at a time rather than precomputing a full list, because quota state can change after each forced refresh.

### 12.3 Single outer `start`

Native streams emit `start` for each attempt. The outer Pi stream must see one `start` only.

Rules:

- Forward the first inner `start`.
- Suppress all later inner `start` events during transparent retries.
- Rewrite the partial message provider back to the public `openai-codex` identity if the native provider or adapter changes it.
- Do not set `meaningfulOutput` on `start`.

This invariant deserves a code comment and a focused regression test.

### 12.4 Meaningful output predicate

Implement one pure helper:

```ts
function isMeaningful(event: AssistantMessageEvent): boolean {
  return event.type === "text_start"
    || event.type === "text_delta"
    || event.type === "text_end"
    || event.type === "thinking_start"
    || event.type === "thinking_delta"
    || event.type === "thinking_end"
    || event.type === "toolcall_start"
    || event.type === "toolcall_delta"
    || event.type === "toolcall_end";
}
```

If empty start/end events are possible, refine the predicate to require non-empty content for deltas and completed blocks. The test suite should encode the actual native Codex event order.

### 12.5 Token injection

Delegate using:

```ts
base.streamSimple(model, context, {
  ...options,
  apiKey: credential.access,
  signal: linkedSignal,
});
```

Do not manually construct authorization headers. Native Codex code already extracts the account ID from the access token and sets the correct request headers.

The explicit profile account ID remains necessary for the usage endpoint and duplicate detection.

### 12.6 WebSocket handling

Do not manage Codex WebSockets directly. The native provider owns transport, connection release, and previous-response fallback.

Each retry creates a new inner stream with the new access token. On provider error, the native implementation marks the failed connection unusable. If a cached continuation response cannot be used by the next account, the native client can fall back to the full local conversation context.

Add integration tests with a fake provider rather than attempting to test OpenAI WebSockets in CI.

### 12.7 Retry bound

The user requirement is at most three complete passes across eligible accounts.

Interpretation:

- A pass may attempt each account at most once.
- Known-zero, disabled, skipped, needs-login, or unexpired-cooldown accounts are not attempted.
- The attempted set resets only at the start of a new pass.
- A second or third pass is useful only after a forced quota refresh or a reset occurred while the request was active.
- If all accounts remain unavailable, enter Quota Wait rather than burning passes.

For ordinary failover, one pass should be enough.

### 12.8 Account switch bookkeeping

On each selected attempt:

- Set active profile in memory and session state.
- Update `lastUsedAt` only when request dispatch begins.
- Show status.
- Log request ID, profile fingerprint, policy, and reason.

On success:

- Set `lastSuccessAt`.
- Clear a consumed one-shot priority.
- Keep a manual `use` pin unless the user intended one-shot behavior. The recommended v1 behavior is persistent for the session.
- Refresh quota asynchronously after completion only when the snapshot is old; do not delay completion summary.

## 13. Partial-output continuation

### 13.1 Why continuation is separate

After meaningful output, transparent request replay is unsafe because:

- The user may see duplicated assistant text.
- The model may generate a repeated tool call.
- Files or external systems may already have changed from prior completed turns.
- The partial assistant message belongs in the saved session for context.

Therefore, the provider wrapper does not retry after meaningful output.

### 13.2 Tagging Relay-owned terminal errors

The wrapper should attach a short machine-readable marker to `error.details` if the event/message type permits it. If not, prefix the error message with a private stable token that is stripped from display by a renderer, or maintain a request ID map until `agent_end`.

Preferred implementation: in-memory map keyed by the final assistant message timestamp/request ID, plus a session checkpoint. Avoid altering visible error text unless Pi provides no structured field.

Recorded details:

```ts
{
  requestId,
  failure: "quota",
  profileId,
  meaningfulOutput: true,
  nextProfileId,
}
```

### 13.3 `agent_end` handler

The handler must be idempotent:

1. Find the last assistant message from the event.
2. Return unless stop reason is `error`.
3. Match it to a Relay request marked `continuationRequired`.
4. Return if a continuation was already queued.
5. Select an eligible profile or begin Quota Wait.
6. Save `continuationPending` before queueing.
7. Send one hidden follow-up.

Use `deliverAs: "followUp"` because the agent run is still settling.

### 13.4 Hidden custom message

Use a custom message rather than a visible user message:

```ts
pi.sendMessage({
  customType: "pi-relay-continuation",
  content: CONTINUE_PROMPT,
  display: false,
  details: { requestId, fromProfileId, toProfileId },
}, { triggerTurn: true, deliverAs: "followUp" });
```

The content enters model context, but the user does not see a fake `continue` turn.

Keep the prompt fixed and short. Do not let users configure it in v1.

### 13.5 Tool idempotency

Do not build a separate tool-call database in v1.

Rationale:

- Pi does not execute tool calls from an errored assistant response.
- Successfully completed tool calls and their results are already in session context.
- The continuation prompt explicitly instructs the model to inspect existing results and not repeat completed side effects.
- Replaying only before meaningful output prevents duplicated emitted tool calls.

Add tests proving:

- A quota error after `toolcall_start` does not trigger transparent replay.
- `agent_end` queues one continuation.
- Existing tool results remain in the context supplied to the next request.

### 13.6 Completion of continuation chain

At `agent_settled`:

- If the chain completed normally, clear `continuationPending` and waiting state.
- Show a compact summary only when Relay switched, retried, or waited.
- Append an idle checkpoint.
- Keep audit log details.

Example:

```text
Relay completed: 2 switches, 3 accounts, waited 37m, pool 46% effective
```

Do not show this for an ordinary single-account request.

## 14. Quota Wait state machine

### 14.1 States

Use five states only:

```text
IDLE
RUNNING
WAITING
PAUSED
CANCELLED
```

`CANCELLED` immediately transitions to `IDLE` after cleanup. It exists conceptually to make cancellation behavior explicit, not necessarily as a stored enum.

### 14.2 Entering WAITING

Enter only when:

- There is a pending request or continuation.
- No account is currently eligible.
- At least one enabled account has a future quota reset or cooldown expiry.
- Quota Wait setting is enabled.
- The request was not aborted.

Compute:

```ts
wakeAt = minFuture(
  profile.exhaustedUntil,
  profile.cooldownUntil,
  primaryResetAt(profile),
  secondaryResetAt(profile),
);
```

Choose the earliest timestamp associated with an account that could become eligible. Add a small grace, such as five seconds, internally.

### 14.3 Live wait before meaningful output

When no account is available before output, keep the original `model`, `context`, and options in the active stream producer and await the timer. This permits exact same-request continuation after quota reopens.

During the wait:

- Keep the outer stream alive.
- Update working text and widget.
- Listen to the linked abort signal.
- Do not emit an assistant error.
- At wake, force-refresh usage and continue the same selection loop.

### 14.4 Wait after partial output

When partial output already exists:

- Let the error complete the current turn.
- Persist a session-level pending continuation.
- Start a wait controller detached from the completed stream.
- At wake, verify the current session still matches the checkpoint.
- Queue the hidden continuation.

Never retain a full model context object across process restart. Pi's session is the durable context.

### 14.5 Cancel

`/relay wait cancel`:

- Abort the timer.
- Clear waiting and continuation-pending state for this chain.
- Remove widget and waiting status.
- Do not disable Quota Wait globally.
- Preserve ordinary Pi session history.
- Notify `Quota Wait cancelled`.

Esc or a user abort while a live request is waiting should have the same effect for that request.

### 14.6 Pause

`/relay wait pause`:

- Abort the active timer.
- Persist `PAUSED` with the pending continuation metadata.
- Keep a compact status line: `Relay paused: task checkpoint saved`.
- Remove the large wait widget.
- Do not auto-resume when quota resets.

If the wait is occurring inside a still-open pre-output stream, the extension cannot keep that stream paused indefinitely across arbitrary user activity. End it with a controlled Relay error and preserve a session-level continuation checkpoint.

### 14.7 Resume

`/relay wait resume`:

- Return if no paused checkpoint exists.
- Refresh all eligible account usage.
- If an account is immediately available, queue continuation now.
- Otherwise enter WAITING with the new earliest reset.

### 14.8 Override

`/relay wait override <account>`:

- Validate the selected account.
- If it reports zero quota, require confirmation in TUI mode; in non-interactive mode reject with a clear message.
- Clear wait timer.
- Pin the account.
- Queue continuation or resume the live request at the next safe boundary.
- Do not clear the global Quota Wait setting.

### 14.9 New user input while waiting

A new interactive user message can conflict with an automatic continuation. Register an `input` handler:

- Ignore extension-originated hidden continuation input.
- Ignore `/relay` commands.
- For ordinary interactive or RPC input while WAITING, pause the pending wait before allowing the new message.
- Notify that the saved task is paused and can be resumed.

This prevents an old task from unexpectedly resuming in the middle of a newer user instruction.

### 14.10 Session switch and shutdown

On session switch or shutdown:

- Cancel live timers.
- Leave a paused checkpoint in the old session if continuation was pending.
- Clear TUI status and widget.
- Do not automatically resume a task in a different session.

On reopening the original session:

- Detect the latest Relay checkpoint.
- Show `Paused Relay task available`.
- Require `/relay wait resume`; do not auto-run immediately after process startup.

This is a deliberate safety boundary. Automatic overnight resume works while the same Pi session remains alive. Restart recovery is explicit to avoid surprising execution after a machine reboot.

## 15. TUI and command design

### 15.1 Status bar

Use `ctx.ui.setStatus("pi-relay", text)`.

Normal examples:

```text
Relay: Personal 42% | next School
Relay: School 81% | pinned
Relay: 3/4 accounts | pool 75%
```

Switching:

```text
Relay: Personal -> School | quota
```

Waiting:

```text
Relay: QUOTA WAIT | Personal in 37m
```

Paused:

```text
Relay: PAUSED | /relay wait resume
```

Keep status under roughly 80 characters where possible.

### 15.2 Widget

Use `setWidget` only for states requiring sustained user attention:

- Quota Wait.
- Paused interrupted task.
- Needs-login state when no usable account remains.

Do not keep the full account dashboard permanently above the editor.

### 15.3 Notifications

Use `ctx.ui.notify()` for:

- Actual account switch.
- Account marked needs login.
- Entry into Quota Wait.
- Wait cancellation, pause, or resume.
- Completion summary when Relay intervened.

Do not notify on every quota refresh, cache hit, or preflight that keeps the same account.

### 15.4 Working message

During an active pre-output failover or wait:

```text
Checking Codex accounts...
Switching to School...
Waiting for Personal quota, 37m remaining...
```

Restore Pi's default working message afterward.

### 15.5 One command family

Register only `/relay`.

Suggested grammar:

```text
/relay
/relay status
/relay add
/relay use <label-or-id>
/relay skip <label-or-id>
/relay disable <label-or-id>
/relay enable <label-or-id>
/relay prioritize <label-or-id>
/relay refresh [label-or-id|all]
/relay policy [smart-reset|most-available|priority-order]
/relay wait [status|cancel|pause|resume|override <account>]
/relay rename <account> <new-label>
/relay remove <account>
/relay logs
```

`/relay logs` should print the log path and perhaps the last ten redacted lines. Do not build a log viewer.

### 15.6 Account identification

Resolve an account argument by:

1. Exact profile ID.
2. Exact case-insensitive label.
3. Unique case-insensitive label prefix.

Reject ambiguous prefixes and print matches. Never identify profiles by access-token data.

### 15.7 Interactive menu

`/relay` can use `ctx.ui.select()` for the main menu:

```text
Accounts
Add account
Refresh usage
Selection policy
Quota Wait
Logs
```

Keep nested menus shallow. Every operation must also have a direct subcommand for RPC and non-interactive modes.

### 15.8 Account action view

Selecting an account shows:

```text
Use
Prioritize
Skip/Clear skip
Disable/Enable
Refresh
Rename
Remove
Back
```

Do not create a custom full-screen TUI component until the standard selectors prove insufficient.

## 16. Audit logging

### 16.1 Files

```text
~/.pi/agent/pi-relay/pi-relay.log
~/.pi/agent/pi-relay/pi-relay.log.1
~/.pi/agent/pi-relay/pi-relay.log.2
~/.pi/agent/pi-relay/pi-relay.log.3
```

Rotate at 1 MiB and retain three old files. Use mode `0600`.

### 16.2 Format

Use JSON Lines for easy debugging:

```json
{"ts":"2026-08-02T09:10:11.000Z","event":"select","request":"a1b2c3","profile":"91f0c2","policy":"smart-reset","reason":"limiting-reset","remaining":42,"resetAt":1785667200000}
```

### 16.3 Required events

- Extension start and version.
- Vault load, migration, and corrupt-file recovery.
- Profile add, remove, rename, enable, disable, skip.
- Usage request start/result/failure.
- Token refresh start/result/failure.
- Selection candidate summary and final decision.
- Stream attempt start.
- Failure classification.
- Account switch.
- Retry pass start/end.
- Continuation queued/completed.
- Quota Wait enter/wake/pause/cancel/resume.
- Completion summary.

### 16.4 Redaction

Never log:

- Access token.
- Refresh token.
- Authorization headers.
- Raw JWT payload.
- Full account ID.
- Full email.
- User prompt.
- Assistant content.
- Tool arguments or results.

Use stable short hashes for account and session correlation:

```ts
const fingerprint = sha256(value).slice(0, 8);
```

Run every log object through a final recursive redactor for keys matching:

```text
token
access
refresh
authorization
cookie
secret
prompt
content
```

The redactor is a defense in depth layer, not a substitute for constructing safe log events.

### 16.5 Logging failure

Logging must never break model execution. Catch write and rotation errors, disable logging for the process after repeated failure, and show at most one warning.

## 17. Security and privacy

### 17.1 File permissions

At every open/write:

- Ensure directory mode `0700`.
- Ensure vault and log mode `0600`.
- Use exclusive temporary-file creation.
- Avoid following unexpected symlinks where practical.

### 17.2 Token boundaries

Actual tokens may exist only in:

- Vault state in memory.
- Vault file.
- Native Codex refresh call.
- Native Codex stream `apiKey` option.
- Usage request authorization header.

They must not enter:

- Pi session messages.
- Custom session entries.
- TUI status.
- Notifications.
- Audit log.
- Error messages.
- Test snapshots.

### 17.3 Removal

Removing an account:

- Requires confirmation in TUI mode.
- Deletes both access and refresh tokens from the next atomic vault state.
- Cancels pending use/prioritize/wait references to that profile.
- Does not attempt remote OAuth revocation in v1.

### 17.4 Provider terms

The README should include one neutral sentence: users are responsible for complying with provider account and usage terms. Do not build policy enforcement into the extension.

## 18. Proposed source layout

Keep the implementation compact:

```text
pi-relay/
  index.ts
  package.json
  tsconfig.json
  README.md
  src/
    types.ts
    pi.ts
    vault.ts
    codex.ts
    usage.ts
    select.ts
    stream.ts
    wait.ts
    command.ts
    ui.ts
    log.ts
  test/
    vault.test.ts
    usage.test.ts
    select.test.ts
    stream.test.ts
    continuation.test.ts
    wait.test.ts
    command.test.ts
    log.test.ts
```

Responsibilities:

- `types.ts`: shared concrete types only.
- `pi.ts`: Pi 0.83.0 bridge and provider construction.
- `vault.ts`: atomic state and refresh compare-and-swap.
- `codex.ts`: JWT metadata, native OAuth refresh, failure classifier, native stream delegation.
- `usage.ts`: `wham/usage` client and pooled calculations.
- `select.ts`: pure eligibility and three policies.
- `stream.ts`: request-local failover state machine.
- `wait.ts`: timer and persistent wait transitions.
- `command.ts`: parser and command actions.
- `ui.ts`: string formatting and standard Pi UI calls.
- `log.ts`: redacted JSONL and rotation.

Do not split files solely to satisfy a line count. Split when a module has an independent invariant and tests.

## 19. Implementation phases

### Phase 0: Freeze scope and compatibility

Tasks:

1. Set package name, likely `pi-relay`.
2. Target Pi 0.83.0 explicitly.
3. Add peer dependencies on `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`.
4. Use Node 22 because Pi 0.83.0 requires it.
5. Add package metadata:

```json
{
  "type": "module",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./index.ts"] }
}
```

6. Add TypeScript strict mode.
7. Add one formatter/linter only if already used by the chosen project template.
8. Write a scope test in `README.md`: Codex first, cross-provider deferred.

Exit criteria:

- `npm install`, typecheck, and an empty extension load under Pi 0.83.0.
- No implementation dependency beyond Pi packages and Node built-ins unless unavoidable.

### Phase 1: Implement vault

Tasks:

1. Copy the minimal locking and atomic-write structure from `pi-auth` with attribution as required by license.
2. Define version 1 schema and default state.
3. Implement `read`, `change`, `getProfile`, `listProfiles`, `add`, `update`, `remove`.
4. Implement generation-based `commitRefresh`.
5. Implement corrupt-file quarantine.
6. Enforce modes.
7. Add stable IDs with `randomUUID()`.
8. Add in-process refresh-promise map outside the vault.

Tests:

- New vault returns default state.
- Add/read/update/remove.
- Concurrent changes do not lose data.
- Stale lock recovery.
- Corrupt file renamed and fresh state created.
- File and directory modes.
- Failed generation commit does not overwrite newer credential.
- Temporary file is not left after successful write.

Exit criteria:

- All vault tests pass under concurrent processes or a simulated lock test.
- No token printed by test failures or snapshots.

### Phase 2: Codex credential helpers

Tasks:

1. Import native `openaiCodexProvider()`.
2. Implement JWT payload decode for `exp` and account ID.
3. Implement token fingerprint.
4. Implement `ensureValidToken()` using native OAuth refresh.
5. Implement in-flight refresh deduplication.
6. Implement auth failure classification.
7. Implement duplicate account detection.

Tests:

- Valid JWT metadata.
- Malformed token returns undefined metadata without throwing.
- Refresh threshold at five minutes.
- Rotated refresh token is stored.
- Concurrent refresh calls share one network call.
- `invalid_grant` marks profile needs login.
- Generation race preserves newer token.

Exit criteria:

- A fake OAuth refresh implementation can update a vault profile safely.

### Phase 3: Usage client

Tasks:

1. Port the smallest relevant logic from `pi-usage`.
2. Accept explicit access token and account ID.
3. Link caller abort and ten-second timeout.
4. Parse primary and secondary windows.
5. Implement 60-second cache check.
6. Implement force refresh.
7. Implement pooled usage and coverage.
8. Map HTTP failures into auth, quota, transient, or invalid-response categories.

Tests:

- Header construction.
- Primary/secondary parsing.
- Missing fields.
- Reset seconds to milliseconds.
- Timeout and abort.
- 401/403/429/500 classification.
- Pool calculation with missing data.
- Cache TTL and forced refresh.

Exit criteria:

- Usage can be fetched independently for two fake profiles with separate tokens.

### Phase 4: Pure selection engine

Tasks:

1. Implement eligibility filter.
2. Implement manual pin and one-shot priority precedence.
3. Implement Smart Reset tuple ranking.
4. Implement Most Available tuple ranking.
5. Implement Priority Order.
6. Implement deterministic tie-breaking.
7. Implement predicted-next function without mutation.
8. Implement skip expiration cleanup.

Tests:

- Disabled, skipped, exhausted, cooldown, and needs-login exclusion.
- Unknown quota ranks below known usable quota.
- Smart Reset chooses the shortest limiting reset.
- Most Available chooses highest effective remaining.
- Priority Order is exact.
- Pin and priority override policy.
- Ineligible pin is handled correctly.
- Stable tie results.

Exit criteria:

- Selection is a pure module with complete branch coverage and no Pi imports.

### Phase 5: Provider auth shim and migration

Tasks:

1. Implement one-time read of native `openai-codex` OAuth credential.
2. Migrate only when Relay vault has no profile and migration marker is absent.
3. Implement custom API-key auth `check`, `resolve`, and `login`.
4. Use secret prompts for both tokens.
5. Validate, add, and return marker credential.
6. Construct full provider replacement with native models.
7. Load extension under Pi and verify model list is unchanged.

Tests:

- Existing OAuth credential migrates once.
- Existing Relay state prevents duplicate migration.
- Marker credential never equals a real token.
- No profile means provider auth check fails clearly.
- Model IDs before and after override are equal.

Exit criteria:

- User can add two fake accounts through the login flow.
- Pi considers `openai-codex` configured.
- Selecting an existing Codex model still works.

### Phase 6: Basic stream delegation

Tasks:

1. Build outer event stream.
2. Select one profile.
3. Refresh token if needed.
4. Delegate to native provider with explicit access token.
5. Forward events unchanged.
6. Track active profile and status.
7. Record success.

Tests:

- Correct token passed to native provider.
- Context and options preserved.
- Caller abort reaches inner stream.
- Outer stream ends exactly once.
- Provider/model identity remains `openai-codex`.

Exit criteria:

- A normal fake Codex request completes through the Relay provider.

### Phase 7: Transparent pre-output failover

Tasks:

1. Add request state and unique request ID.
2. Add strict failure classifier.
3. Add meaningful-output predicate.
4. Forward only one outer `start`.
5. On pre-output quota, force-refresh usage and exclude account.
6. Select and retry another account.
7. Add three-pass bound.
8. Skip known-zero profiles.
9. Add account-switch UI and log events.

Tests:

- `start -> quota error` rotates, because `start` is not meaningful.
- Only one outer `start` reaches Pi.
- `text_start -> quota error` does not transparent-retry.
- Known-zero account is not attempted.
- Auth-invalid account is skipped.
- Generic network error does not poison account.
- Three-pass bound terminates.
- Aborted request never rotates.

Exit criteria:

- Two-account fake scenario finishes the same request after account A quota failure and account B success.

### Phase 8: Partial-output continuation

Tasks:

1. Mark continuation-required requests.
2. Register `agent_end` handler.
3. Match the final error to the Relay request.
4. Select next profile.
5. Persist continuation checkpoint.
6. Queue hidden custom follow-up exactly once.
7. Clear checkpoint at `agent_settled`.
8. Add compact completion summary only when Relay intervened.

Tests:

- Partial text plus quota queues one continuation.
- Partial thinking plus quota queues one continuation.
- Tool-call start plus quota queues one continuation, not replay.
- Non-quota error does not continue.
- Duplicate `agent_end` handling is idempotent.
- Hidden message has `display: false` and `deliverAs: followUp`.
- Existing session messages and tool results are in next context.

Exit criteria:

- Fake two-turn integration reproduces the manual `continue` behavior without a visible user turn.

### Phase 9: Quota Wait

Tasks:

1. Implement earliest-wake calculation.
2. Implement live pre-output wait.
3. Implement session-level post-output wait.
4. Add grace interval after reset.
5. Add widget and countdown refresh no more than once per second in TUI.
6. Add cancel, pause, resume, override.
7. Add input handler that pauses on new user work.
8. Add session shutdown cleanup.
9. Add restart detection as paused, not automatic execution.

Tests with fake timers:

- Earliest reset selected.
- No busy polling.
- Wake forces usage refresh.
- Still-exhausted result reschedules.
- Cancel prevents continuation.
- Pause persists checkpoint.
- Resume continues immediately when quota exists.
- Override uses chosen account.
- New user input pauses pending task.
- Session switch cancels timer.

Exit criteria:

- A fake exhausted pool waits, wakes, and resumes without user intervention in the same live session.

### Phase 10: Commands and dashboard

Tasks:

1. Implement argument parser with direct subcommands.
2. Implement account resolver.
3. Implement standard selector-based interactive menu.
4. Implement account lines, pooled usage, next prediction.
5. Implement use, skip, disable, enable, prioritize.
6. Implement policy command.
7. Implement refresh, rename, remove.
8. Implement wait controls.
9. Implement log-path command.
10. Make non-TUI output plain text.

Tests:

- Every command parses valid and invalid forms.
- Ambiguous labels reject.
- Account mutations persist.
- Remove requires confirmation in TUI.
- Non-interactive behavior is deterministic.
- Status output never includes token material.

Exit criteria:

- All required workflows can be completed without editing JSON manually.

### Phase 11: Audit log

Tasks:

1. Implement JSONL append.
2. Implement recursive redactor.
3. Implement 1 MiB rotation and three backups.
4. Enforce permissions.
5. Add safe logging calls to all state transitions.
6. Add one-warning failure behavior.

Tests:

- Token-like keys are redacted recursively.
- Prompts and content cannot be logged.
- Rotation order and retention.
- Logging failure does not fail request.
- File mode.

Exit criteria:

- A full fake failover produces enough data to diagnose selection and waiting without exposing secrets.

### Phase 12: Real Pi integration testing

Create a local test extension harness using Pi's SDK or a fake provider registered under a test ID.

Scenarios:

1. One healthy account, normal completion.
2. Account A quota before output, B completes.
3. A quota after partial text, hidden continuation through B.
4. A and B exhausted, wait until A reset, resume.
5. A token expires, refresh succeeds.
6. A refresh invalid, B used.
7. B disabled, not selected.
8. User pins B, B selected on next request.
9. User types new task during wait, old task pauses.
10. Pi process exits during paused wait and later reloads checkpoint.
11. WebSocket-like error after start but before meaningful output.
12. Completed tool result remains visible to continuation.

Do not use real tokens in CI. Add an opt-in manual smoke-test script for real accounts outside the repository or via environment variables ignored by git.

Exit criteria:

- All fake scenarios pass.
- Manual two-account Codex smoke test succeeds without token leakage.

### Phase 13: Compatibility and failure hardening

Tasks:

1. Verify exact package export paths in published Pi 0.83.0.
2. Verify extension load under Node and Pi's TypeScript loader.
3. Test missing or changed native provider factory with a clear startup error.
4. Test no TUI mode.
5. Test corrupted state and log paths.
6. Test two Pi processes reading and refreshing the same vault.
7. Test provider retry settings at Pi defaults.
8. Confirm Relay does not fight Pi's native transient retries.
9. Pin tests to the AssistantMessage event protocol.

Exit criteria:

- Failure modes are clear, bounded, and recoverable.

### Phase 14: Release preparation

Tasks:

1. Keep README concise.
2. Add MIT license or chosen compatible license.
3. Include source attributions where adapted code requires it.
4. Verify package `files` includes only source, README, and license.
5. Run typecheck, tests, and package dry-run.
6. Inspect tarball for tokens, local state, logs, and fixtures.
7. Tag `0.1.0` as Codex-only beta.
8. State Pi 0.83.0 compatibility.

Exit criteria:

- Clean install through `pi install`.
- No secret files in package.
- README path from install to first working account is under ten lines.

## 20. Test matrix

### 20.1 Selection tests

| Case | Expected result |
| --- | --- |
| Two usable accounts, A resets earlier | Smart Reset selects A |
| A has 5% effective remaining, B has 80%, A resets earlier | Smart Reset selects A unless A is zero |
| A unknown, B known usable | B selected |
| A pinned but exhausted | Pin cleared for this chain, B selected |
| A prioritized but disabled | Priority ignored and preserved or cleared with explicit reason; recommended: clear |
| A skipped until reset | A excluded before reset and eligible afterward |
| Priority Order B,A,C | First eligible in that exact order |
| Most Available A=40%, B=70% | B selected |
| Exact tie | Stable configured order wins |

### 20.2 Stream tests

| Inner events | Expected outer behavior |
| --- | --- |
| `start, error(quota)` then B `start, text, done` | One outer start, B output, success |
| `start, text_start, error(quota)` | Error forwarded, no same-request replay, continuation queued |
| `start, thinking_start, error(quota)` | Continuation path |
| `start, toolcall_start, error(quota)` | Continuation path, no tool execution from failed message |
| `start, error(network)` | Error surfaced, no quota state mutation |
| `start, error(auth)` then B success | A needs login, B used |
| Abort during A stream | Abort surfaced, no B attempt |
| All profiles report zero | No stream attempt; Quota Wait or terminal exhausted result |
| Same account selected twice in one pass | Test must fail |
| More than three passes | Test must fail |

### 20.3 Quota Wait tests

| Case | Expected result |
| --- | --- |
| A resets in 10m, B in 2h | Wake for A |
| A wake arrives but still zero | Recompute and remain waiting |
| Cancel before wake | No request or continuation |
| Pause before wake | Checkpoint remains, no timer |
| Resume with available B | Immediate selection of B |
| User sends new input | Existing wait pauses before input continues |
| Session closes | Timer cancelled; checkpoint becomes paused |
| Restart into session | No automatic execution; resume available |

### 20.4 Security tests

- Search logs for every fake token and assert none occur.
- Search Pi custom session entries for every fake token and assert none occur.
- Verify vault and log permissions after every write.
- Verify errors generated from refresh responses are sanitized before display.
- Verify raw usage response is not logged.
- Verify duplicate account error references only label or fingerprint.

### 20.5 Race tests

- Two concurrent refreshes for one profile make one network call in process.
- Two processes refresh one profile; only the current generation commits.
- Usage refresh and token refresh overlap safely.
- Account removed while usage request is in flight; result is discarded.
- Account disabled during preflight; request does not dispatch to it if the change lands before stream start.
- Quota Wait cancelled at the same moment its timer fires; exactly one path wins.
- `agent_end` and wait wake race; continuation queues once.

## 21. Acceptance criteria

Pi Relay v1 is complete only when all are true:

### Account management

- User can add a labeled account by pasting access and refresh tokens through masked prompts.
- Duplicate Codex accounts are detected by account ID.
- User can rename, remove, enable, disable, skip, use, and prioritize profiles.
- Tokens persist with owner-only permissions.
- Expired access tokens refresh automatically and rotated refresh tokens are saved.

### Usage visibility

- Dashboard shows primary and secondary remaining percentages and reset times per account.
- Active account and predicted next account are distinct and visible.
- Pooled primary, secondary, and effective remaining estimates are shown with measurement coverage.
- Usage data comes from explicit per-profile credentials, not only the active Pi credential.

### Selection

- Preflight runs before every Codex request.
- Exactly three policies exist.
- Smart Reset chooses the eligible account with the earliest limiting reset using deterministic tie-breakers.
- Manual pin and one-shot priority are honored.

### Failover

- Confirmed quota failure before meaningful output retries the same request on another account.
- The outer event stream emits one start event.
- Failure after meaningful output never replays the same request.
- Partial-output failures queue one hidden continuation in the same Pi session.
- Known-zero accounts are not retried.
- Retry work is bounded to three passes.

### Waiting

- All-exhausted state enters Quota Wait by default.
- Wait state is obvious in status and widget.
- Earliest reset is used without busy polling.
- Task resumes when quota becomes available in the live session.
- Cancel, pause, resume, and override work.
- New user input pauses the old pending task.

### Reliability

- Completed Pi tool calls are not replayed by transparent request retry.
- Session history remains Pi's source of truth.
- Crash/restart leaves a recoverable paused checkpoint.
- Account refresh races do not overwrite newer credentials.
- Corrupt vault state is quarantined rather than destroyed.

### Observability

- Verbose redacted rolling log records all decisions and transitions.
- Completion summary appears only when Relay intervened.
- No token, prompt, assistant content, or tool content reaches logs or session checkpoints.

## 22. Risks and mitigations

### Risk: Pi provider API changes

Mitigation:

- Target Pi 0.83.0 first.
- Isolate imports and registration in `src/pi.ts`.
- Add a startup compatibility check for native provider shape.
- Add CI against the pinned target before widening the version range.

### Risk: Codex usage endpoint changes

Mitigation:

- Keep response parsing isolated in `usage.ts`.
- Treat missing fields as unknown, not zero.
- Surface a clear dashboard warning.
- Continue using strict stream error classification when usage is unavailable.

### Risk: Provider emits `start` before immediate quota error

Mitigation:

- Do not treat `start` as meaningful output.
- Suppress duplicate `start` events across attempts.
- Add regression test based on exact event order.

### Risk: Duplicate continuation

Mitigation:

- Persist `continuationPending` before queueing.
- Match request ID in `agent_end`.
- Clear only at `agent_settled` or cancellation.
- Test repeated handler invocation.

### Risk: Wrong account chosen due to stale usage

Mitigation:

- Refresh stale candidates before selection.
- Force refresh after quota failure and reset wake.
- Display cache age or freshness coverage in detailed status.
- Keep selection deterministic.

### Risk: Access token refresh races

Mitigation:

- In-process promise deduplication.
- Cross-process generation compare-and-swap.
- Atomic vault writes.

### Risk: Quota Wait resumes an obsolete task

Mitigation:

- Pause on new user input.
- Bind checkpoint to session identity and request ID.
- Cancel on session switch.
- Require explicit resume after process restart.

### Risk: Mixed provider retries conflict with Pi retry logic

Mitigation:

- In v1, rotate only for strict quota/auth failures.
- Do not rotate on generic transient errors.
- Keep cross-provider failover deferred.
- Log classification decisions.

### Risk: Plaintext token exposure

Mitigation:

- Owner-only filesystem permissions.
- Atomic exclusive writes.
- Aggressive redaction.
- Clear README disclosure.
- No tokens in Pi session or status.

### Risk: Terms or service changes

Mitigation:

- Keep provider-specific behavior in the adapter.
- Avoid claims of guaranteed unlimited usage.
- State that users must comply with provider terms.

## 23. YAGNI review gates

At the end of each phase, ask:

1. Is this code necessary for a stated v1 behavior?
2. Is it required for correctness, security, recovery, or testing?
3. Can the same result be achieved by delegating to Pi or the native provider?
4. Can an interface be replaced by a function until a second implementation exists?
5. Can a setting become an internal constant?
6. Can a custom TUI component become a standard `select`, `input`, `status`, or `widget` call?
7. Is state already present in Pi's session instead of needing duplication?
8. Is a retry justified by a precise failure classification?
9. Does a comment explain an invariant, or merely restate code?
10. Would deleting this feature make the required workflow fail?

Reject the addition when question 10 is no.

## 24. Minimal README specification

The final README should be approximately this size and no larger unless installation needs change:

```md
# Pi Relay

Pi extension that uses multiple OpenAI Codex accounts, selects the best available quota, switches on account limits, and resumes interrupted tasks.

## Install

\`\`\`sh
pi install npm:pi-relay
\`\`\`

Restart Pi.

## Add accounts

\`\`\`
/relay add
\`\`\`

Enter a label, access token, and refresh token. Secret fields are masked.

## Commands

| Command | Action |
| --- | --- |
| \`/relay\` | Accounts and usage |
| \`/relay use <account>\` | Use at next safe request |
| \`/relay prioritize <account>\` | Prefer next |
| \`/relay skip <account>\` | Skip until reset |
| \`/relay disable|enable <account>\` | Exclude or restore |
| \`/relay refresh [all]\` | Refresh usage |
| \`/relay policy <name>\` | Select policy |
| \`/relay wait <action>\` | Control Quota Wait |

## Behavior

Before output, quota failures retry the same request on another account. After partial output, Pi Relay continues in the same session with a hidden follow-up. If every account is exhausted, Quota Wait resumes after the earliest reset unless cancelled or paused.

## Data

Tokens are stored in \`~/.pi/agent/pi-relay/state.json\` with owner-only permissions. They are not encrypted. Anyone who can read files as your OS user can read them.

Users are responsible for complying with provider account and usage terms.

## Development

\`\`\`sh
npm test
npm run typecheck
\`\`\`
```

Do not add architecture diagrams, long troubleshooting sections, or provider roadmaps to v1 README. Put only genuinely recurring troubleshooting into it after users encounter it.

## 25. Code style rules

- TypeScript strict mode.
- Prefer `const` and pure functions.
- Prefer early returns.
- Prefer `Promise.allSettled()` for independent usage checks.
- Avoid inheritance.
- Avoid decorators.
- Avoid runtime schema libraries unless malformed state becomes unmanageable with a small validator.
- Avoid single-use wrapper types.
- Keep error messages actionable and token-free.
- Use named constants only for values with domain meaning.
- Keep selection comparison as tuples, not scores.
- Keep commands as a simple switch on the first argument.
- Keep one timer owner in `WaitController`.
- Keep one stream producer owner per request.
- Do not catch errors unless adding classification, cleanup, or a user-facing boundary.

Example command shape:

```ts
switch (subcommand) {
  case undefined:
  case "status": return showStatus(ctx);
  case "add": return addAccount(ctx);
  case "use": return useAccount(args, ctx);
  default: return ctx.ui.notify(`Unknown Relay command: ${subcommand}`, "error");
}
```

## 26. Future extension seam, not v1 work

The architecture should permit a future provider adapter for Anthropic without implementing it now.

A future mixed-provider pool additionally needs:

- Mapping an equivalent model across providers.
- Preserving thinking level across model changes.
- Provider-specific quota normalization.
- Provider-specific usage and reset APIs.
- Explicit user order between providers.
- Rules for incompatible context or tool capabilities.

Do not implement generic model-equivalence logic in Codex v1. The only future-proofing required now is that quota, refresh, classification, and stream delegation live in `CodexAdapter` rather than being scattered through UI and vault code.

## 27. Recommended build order summary

The shortest safe path is:

1. Vault.
2. Native Codex provider wrapper with one profile.
3. Explicit usage client.
4. Pure selector.
5. Multi-profile pre-output rotation.
6. Partial-output hidden continuation.
7. Quota Wait.
8. Commands and dashboard.
9. Logging.
10. Integration hardening and release.

Do not build the dashboard first. The hard correctness boundary is stream recovery. Prove it with fake providers before investing in TUI polish.

## 28. Final architectural invariants

These must remain true throughout implementation:

1. Pi core is unmodified.
2. Public provider ID remains `openai-codex`.
3. Native Codex provider performs the actual protocol and transport.
4. Pi Relay selects credentials per request.
5. Tokens never enter Pi session history.
6. `start` is not meaningful output.
7. Same-request retries happen only before meaningful output.
8. After meaningful output, recovery is a hidden session continuation.
9. Pi session history is the authority for completed work.
10. All retries are bounded.
11. Known-zero accounts are not retried.
12. All-exhausted state waits by reset timestamp, not busy polling.
13. User input can pause an old waiting task.
14. Refresh writes use generation compare-and-swap.
15. Logs are useful without containing secrets or conversation content.
16. Only three selection policies exist.
17. No feature is added merely because another extension has it.

## 29. Source review map

### Uploaded source

Pi 0.83.0:

- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/src/core/extensions/loader.ts`
- `packages/coding-agent/src/core/extensions/runner.ts`
- `packages/coding-agent/src/core/model-runtime.ts`
- `packages/coding-agent/src/core/auth-storage.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/session-manager.ts`
- `packages/agent/src/agent-loop.ts`
- `packages/ai/src/models.ts`
- `packages/ai/src/types.ts`
- `packages/ai/src/auth/types.ts`
- `packages/ai/src/auth/helpers.ts`
- `packages/ai/src/auth/oauth/openai-codex.ts`
- `packages/ai/src/providers/openai-codex.ts`
- `packages/ai/src/api/openai-codex-responses.ts`
- Extension, provider, session, TUI, and SDK documentation under `packages/coding-agent/docs` and examples under `packages/coding-agent/examples/extensions`.

Uploaded `pi-auth`:

- `src/index.ts`
- `src/vault.ts`
- `src/manager.ts`
- `src/auth-mirror.ts`
- `src/usage.ts`
- Tests and README.

Uploaded `pi-usage`:

- `index.ts`
- `src/cache.ts`
- `src/providers/codex.ts`
- `src/types.ts`
- Tests and README.

### Current official documentation

- Pi extensions: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- Pi custom providers: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md
- Pi provider documentation: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md
- Pi extension examples: https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions

### Existing extension implementations reviewed

- https://github.com/kim0/pi-multicodex
- https://github.com/victor-software-house/pi-multicodex
- https://github.com/hjanuschka/pi-multi-pass
- https://github.com/MasuRii/pi-multi-auth
- https://github.com/khanhicetea/pi-multi-codex
- https://github.com/Sarrius/pi-multi-account
- https://github.com/MateuszJuszczyk/omp-codex-account

## 30. Final recommendation

Implement Pi Relay as a same-ID full provider override with an extension-owned, permission-restricted credential vault.

Use the native Codex provider for OAuth refresh and streaming. Use the `wham/usage` endpoint for explicit per-profile quota. Select before every request. Retry transparently only before meaningful output. After partial output, use Pi's existing `agent_end` follow-up mechanism to continue in the same saved session. When every account is exhausted, enter a visible, cancellable Quota Wait and resume at the earliest verified reset.

This is the smallest architecture that supports every required behavior without modifying Pi core, duplicating Pi's session engine, or importing the complexity of broader multi-provider extensions.
