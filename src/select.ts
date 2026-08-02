import type { Policy, RelayProfile } from "./types.js";
import { limitingRemaining, remaining } from "./usage.js";

export type SelectionOverrides = { pinnedProfileId?: string; prioritizedProfileId?: string };
export type Selection = { profile?: RelayProfile; source?: "pin" | "priority" | Policy; clearPin?: boolean; consumePriority?: boolean };

export const isEligible = (profile: RelayProfile, now = Date.now(), attempted: ReadonlySet<string> = new Set()): boolean =>
  profile.enabled && !profile.needsLogin && !attempted.has(profile.id)
  && !future(profile.skippedUntil, now) && !future(profile.cooldownUntil, now) && !future(profile.exhaustedUntil, now)
  && limitingRemaining(profile.quota) !== 0 && !!profile.credential.access && !!profile.credential.refresh;

export function selectProfile(
  profiles: RelayProfile[], policy: Policy, overrides: SelectionOverrides = {}, now = Date.now(), attempted: ReadonlySet<string> = new Set(), priorityOrder: string[] = [],
): Selection {
  const eligible = profiles.filter((profile) => isEligible(profile, now, attempted));
  const pinned = profiles.find((profile) => profile.id === overrides.pinnedProfileId);
  if (pinned && eligible.includes(pinned)) return { profile: pinned, source: "pin" };
  const prioritized = profiles.find((profile) => profile.id === overrides.prioritizedProfileId);
  if (prioritized && eligible.includes(prioritized)) return { profile: prioritized, source: "priority", consumePriority: true, ...(pinned && permanentlyIneligible(pinned) ? { clearPin: true } : {}) };
  const ordered = [...eligible].sort(policy === "smart-reset" ? smartComparator : policy === "most-available" ? availableComparator : priorityComparator(priorityOrder));
  return {
    ...(ordered[0] ? { profile: ordered[0], source: policy } : {}),
    ...(pinned && permanentlyIneligible(pinned) ? { clearPin: true } : {}),
    ...(prioritized && !eligible.includes(prioritized) ? { consumePriority: true } : {}),
  };
}

export const predictedNext = (profiles: RelayProfile[], policy: Policy, now = Date.now(), priorityOrder: string[] = []): RelayProfile | undefined =>
  selectProfile(profiles, policy, {}, now, new Set(), priorityOrder).profile;

export const earliestFutureReset = (profile: RelayProfile, now = Date.now()): number | undefined => {
  const values = [profile.quota?.primary?.resetAt, profile.quota?.secondary?.resetAt].filter((value): value is number => value !== undefined && value > now);
  return values.length ? Math.min(...values) : undefined;
};

const future = (value: number | undefined, now: number) => value !== undefined && value > now;
const permanentlyIneligible = (profile: RelayProfile) => !profile.enabled || !!profile.needsLogin || limitingRemaining(profile.quota) === 0;
const known = (profile: RelayProfile) => limitingRemaining(profile.quota) === undefined ? 1 : 0;
const limitingReset = (profile: RelayProfile) => {
  const primary = remaining(profile.quota?.primary), secondary = remaining(profile.quota?.secondary);
  if (primary === undefined && secondary === undefined) return Number.MAX_SAFE_INTEGER;
  return (secondary === undefined || (primary !== undefined && primary <= secondary) ? profile.quota?.primary?.resetAt : profile.quota?.secondary?.resetAt) ?? Number.MAX_SAFE_INTEGER;
};
const compare = (left: number[], right: number[]) => {
  for (let index = 0; index < left.length; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
};
const smartComparator = (a: RelayProfile, b: RelayProfile) => compare(
  [known(a), limitingReset(a), limitingRemaining(a.quota) ?? 101, a.lastUsedAt ?? 0, a.order],
  [known(b), limitingReset(b), limitingRemaining(b.quota) ?? 101, b.lastUsedAt ?? 0, b.order],
);
const availableComparator = (a: RelayProfile, b: RelayProfile) => compare(
  [known(a), -(limitingRemaining(a.quota) ?? -1), -(remaining(a.quota?.primary) ?? -1), limitingReset(a), a.lastUsedAt ?? 0, a.order],
  [known(b), -(limitingRemaining(b.quota) ?? -1), -(remaining(b.quota?.primary) ?? -1), limitingReset(b), b.lastUsedAt ?? 0, b.order],
);
const priorityComparator = (order: string[]) => (a: RelayProfile, b: RelayProfile) =>
  compare([position(order, a), a.order], [position(order, b), b.order]);
const position = (order: string[], profile: RelayProfile) => {
  const index = order.indexOf(profile.id);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
};
