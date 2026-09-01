import type { AgentId, AgentMetadata } from "../../shared/types";

export interface AgentAvailabilityRow {
  id: AgentId;
  label: string;
  enabled: boolean;
  reason: string;
}

const FALLBACK_LABELS: Record<AgentId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export function agentLabel(
  agentId: AgentId,
  metadataByAgent: Record<string, AgentMetadata | null> = {},
): string {
  return metadataByAgent[agentId]?.label ?? FALLBACK_LABELS[agentId] ?? "Claude Code";
}

export function buildAgentAvailabilityRows(
  agents: AgentMetadata[],
  metadataByAgent: Record<string, AgentMetadata | null>,
): AgentAvailabilityRow[] {
  return agents.map((agent) => {
    const metadata = metadataByAgent[agent.id] ?? agent;
    const binaryAvailable = metadata?.available === true;

    return {
      id: agent.id,
      label: metadata?.label ?? agent.label,
      enabled: binaryAvailable,
      reason: metadata?.unavailableReason ?? `${agent.label} is not installed`,
    };
  });
}
