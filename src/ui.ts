import type { RelayProfile, RelayState } from "./types.js";
import { poolUsage, remaining } from "./usage.js";

export const formatPercent = (value?: number) => value === undefined ? "?" : `${Math.round(value)}%`;
export const formatDuration = (seconds?: number) => {
  if (!seconds) return "quota";
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
};
export const formatReset = (at?: number, now = Date.now()) => {
  if (!at) return "?";
  const minutes = Math.max(0, Math.ceil((at - now) / 60_000));
  return minutes >= 1440 ? `${Math.ceil(minutes / 1440)}d` : minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`;
};

export const profileStatus = (profile: RelayProfile, activeId?: string, now = Date.now()) => {
  if (!profile.enabled) return "DISABLED";
  if (profile.needsLogin) return "NEEDS LOGIN";
  if ((profile.skippedUntil ?? 0) > now) return "SKIPPED";
  if ((profile.cooldownUntil ?? 0) > now) return "COOLDOWN";
  if ((profile.exhaustedUntil ?? 0) > now) return "EXHAUSTED";
  return profile.id === activeId ? "ACTIVE" : "AVAILABLE";
};

export const accountLine = (profile: RelayProfile, activeId?: string, now = Date.now()) => {
  const window = (name: "primary" | "secondary") => {
    const value = profile.quota?.[name];
    return `${formatDuration(value?.windowSeconds)} ${formatPercent(remaining(value))} left / ${formatReset(value?.resetAt, now)}`;
  };
  return `${profile.id === activeId ? "*" : " "} ${profile.label.padEnd(18)} ${profileStatus(profile, activeId, now).padEnd(12)} ${window("primary")}  ${window("secondary")}`;
};

export const dashboard = (state: RelayState, activeId?: string, nextId?: string, now = Date.now()) => {
  const profiles = Object.values(state.profiles).sort((a, b) => a.order - b.order);
  const pool = poolUsage(profiles.filter((profile) => profile.enabled), now);
  const next = nextId ? state.profiles[nextId]?.label : undefined;
  return [
    "PI RELAY", "", ...profiles.map((profile) => accountLine(profile, activeId, now)), "",
    `Next predicted: ${next ?? "none"}`,
    `Pool: ${formatPercent(pool.primary)} | ${formatPercent(pool.secondary)} | effective ${formatPercent(pool.effective)} | ${pool.measured}/${pool.total} fresh`,
    `Policy: ${state.settings.policy}`,
    `Quota Wait: ${state.settings.quotaWait ? "on" : "off"}`,
  ].join("\n");
};
