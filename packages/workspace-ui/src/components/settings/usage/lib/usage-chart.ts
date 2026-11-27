import type { AgentId } from "@solus/contracts/types";
import type {
  UsagePace,
  UsagePoolWindow,
  UsageProviderGroup,
  UsageStateFilter,
  UsageTone,
} from "@solus/client-core/usage-limits";

export function usageBarColor(tone: UsageTone, provider: AgentId): string {
  if (tone === "spent") return "var(--solus-art-negative)";
  if (tone === "low") return "var(--solus-art-2)";
  if (provider === "claude-code") return "var(--brand-claude)";
  if (provider === "codex") return "var(--brand-codex)";
  if (provider === "antigravity") return "var(--solus-art-positive)";
  return "var(--solus-art-positive)";
}

export function usagePaceTextClass(pace: UsagePace | null, suppressed: boolean): string {
  if (suppressed) return "font-medium text-(--solus-art-negative)";
  if (pace === "ahead") return "font-medium text-(--solus-art-2)";
  if (pace === "under") return "text-(--solus-art-positive)";
  return "text-muted-foreground";
}

export function usageWindowSubtitle(window: UsagePoolWindow, isPooled: boolean): string {
  if (isPooled) return `${window.label} · pooled`;
  if (window.kind === "session") return "Session · 5h";
  // The label, not a fixed word: Claude's Fable week is a second weekly window.
  if (window.kind === "weekly") return `${window.label} · 7d`;
  if (window.kind === "monthly") return "Monthly · 30d";
  return window.label;
}

export function hostFilterSummary(
  selectedIds: ReadonlySet<string>,
  hosts: ReadonlyArray<{ serverId: string; label: string }>,
): string {
  if (selectedIds.size === 0 || selectedIds.size >= hosts.length) {
    return hosts.length > 1 ? `All (${hosts.length})` : hosts[0]?.label ?? "All";
  }
  if (selectedIds.size === 1) {
    const onlyId = [...selectedIds][0];
    return hosts.find((host) => host.serverId === onlyId)?.label ?? "1 host";
  }
  return `${selectedIds.size} of ${hosts.length}`;
}

export function harnessFilterSummary(
  selectedProviders: ReadonlySet<AgentId>,
  providers: readonly UsageProviderGroup[],
): string {
  if (selectedProviders.size === 0 || selectedProviders.size >= providers.length) return "All";
  if (selectedProviders.size === 1) {
    const onlyProvider = [...selectedProviders][0];
    return providers.find((group) => group.provider === onlyProvider)?.label ?? "1 harness";
  }
  return `${selectedProviders.size} selected`;
}

export const USAGE_STATE_OPTIONS: ReadonlyArray<{
  readonly value: UsageStateFilter;
  readonly label: string;
}> = [
  { value: "all", label: "All" },
  { value: "issues", label: "Needs attention" },
  { value: "ahead", label: "Ahead of pace" },
  { value: "blocked", label: "Blocked or spent" },
  { value: "signed_out", label: "Signed out" },
];

export function usageStateLabel(state: UsageStateFilter): string {
  return USAGE_STATE_OPTIONS.find((option) => option.value === state)?.label ?? "All";
}

export function formatShortResetClock(resetsAt: number | null): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return null;
  const target = new Date(resetsAt);
  const now = new Date();
  const sameDay =
    target.getFullYear() === now.getFullYear() &&
    target.getMonth() === now.getMonth() &&
    target.getDate() === now.getDate();
  if (sameDay) {
    return `Today, ${target.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  return target.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
