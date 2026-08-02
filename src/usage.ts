import type { CodexQuotaSnapshot, QuotaWindow, RelayProfile } from "./types.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const USAGE_TTL_MS = 60_000;

export class UsageError extends Error {
  constructor(readonly kind: "auth" | "rate-limit" | "transient" | "invalid-response", message: string) { super(message); }
}

export async function fetchUsage(
  credential: RelayProfile["credential"],
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<CodexQuotaSnapshot> {
  const timeout = AbortSignal.timeout(10_000);
  const linked = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetcher(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credential.access}`,
        Accept: "application/json",
        Referer: "https://chatgpt.com/codex/settings/usage",
        "X-OpenAI-Target-Path": "/backend-api/wham/usage",
        ...(credential.accountId ? { "ChatGPT-Account-Id": credential.accountId } : {}),
      },
      signal: linked,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new UsageError("transient", "Codex usage request failed");
  }
  if (response.status === 401 || response.status === 403) throw new UsageError("auth", `Codex usage returned ${response.status}`);
  if (response.status === 429) throw new UsageError("rate-limit", "Codex usage is rate limited");
  if (response.status >= 500) throw new UsageError("transient", `Codex usage returned ${response.status}`);
  if (!response.ok) throw new UsageError("invalid-response", `Codex usage returned ${response.status}`);
  const body: unknown = await response.json().catch(() => undefined);
  if (!body || typeof body !== "object") throw new UsageError("invalid-response", "Invalid Codex usage response");
  const value = body as Record<string, unknown>;
  const rateLimit = record(value.rate_limit) ?? value;
  const primary = parseWindow(rateLimit.primary_window ?? value.primary ?? rateLimit, now);
  const secondary = parseWindow(rateLimit.secondary_window ?? value.secondary_rate_limit ?? value.secondary, now);
  if (!primary && !secondary) throw new UsageError("invalid-response", "Codex usage windows are missing");
  return { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}), fetchedAt: now };
}

const parseWindow = (input: unknown, now: number): QuotaWindow | undefined => {
  const value = record(input);
  if (!value) return undefined;
  const window = record(value.limit_window) ?? value;
  const usedPercent = number(value.used_percent ?? window.used_percent);
  const resetAt = resetTime(value.reset_at ?? window.reset_at, value.reset_after_seconds ?? window.reset_after_seconds, now);
  const windowSeconds = number(value.limit_window_seconds ?? window.limit_window_seconds);
  if (usedPercent === undefined && resetAt === undefined && windowSeconds === undefined) return undefined;
  return {
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(windowSeconds === undefined ? {} : { windowSeconds }),
  };
};
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" ? value as Record<string, unknown> : undefined;
const number = (value: unknown): number | undefined => {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
};
const resetTime = (reset: unknown, after: unknown, now: number): number | undefined => {
  if (typeof reset === "string" && !Number.isFinite(Number(reset))) { const parsed = Date.parse(reset); return Number.isFinite(parsed) ? parsed : undefined; }
  const epoch = number(reset);
  if (epoch !== undefined) return epoch < 10_000_000_000 ? epoch * 1000 : epoch;
  const seconds = number(after);
  return seconds === undefined ? undefined : now + seconds * 1000;
};
export const remaining = (window?: QuotaWindow): number | undefined => window?.usedPercent === undefined ? undefined : Math.max(0, 100 - window.usedPercent);
export const limitingRemaining = (quota?: CodexQuotaSnapshot): number | undefined => minDefined(remaining(quota?.primary), remaining(quota?.secondary));
export const isFresh = (quota: CodexQuotaSnapshot | undefined, now = Date.now()): boolean => !!quota && now - quota.fetchedAt < USAGE_TTL_MS && ![quota.primary?.resetAt, quota.secondary?.resetAt].some((reset) => reset !== undefined && reset <= now);

export const poolUsage = (profiles: RelayProfile[], now = Date.now()) => {
  const measured = profiles.filter((profile) => isFresh(profile.quota, now));
  const average = (values: Array<number | undefined>) => {
    const known = values.filter((value): value is number => value !== undefined);
    return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : undefined;
  };
  const primary = average(measured.map((profile) => remaining(profile.quota?.primary)));
  const secondary = average(measured.map((profile) => remaining(profile.quota?.secondary)));
  return { primary, secondary, effective: minDefined(primary, secondary), measured: measured.length, total: profiles.length };
};

const minDefined = (...values: Array<number | undefined>): number | undefined => {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length ? Math.min(...known) : undefined;
};
