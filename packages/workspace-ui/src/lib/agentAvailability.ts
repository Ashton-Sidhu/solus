import type { AgentId, AgentMetadata } from "@solus/contracts/types";
import { isModelPickerAgentVisible } from "@solus/client-core/model-picker-agents";

export interface AgentAvailabilityRow {
  id: AgentId;
  label: string;
  enabled: boolean;
  reason: string;
}

const FALLBACK_LABELS = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  replay: "Replay (dev)",
} satisfies Record<AgentId, string>;

export function agentLabel(
  agentId: AgentId,
  metadataByAgent: Record<string, AgentMetadata | null> = {},
): string {
  return metadataByAgent[agentId]?.label ?? FALLBACK_LABELS[agentId] ?? "Claude Code";
}

export function buildAgentAvailabilityRows(
  agents: AgentMetadata[],
  metadataByAgent: Record<string, AgentMetadata | null>,
  isDevelopment = false,
): AgentAvailabilityRow[] {
  return agents.filter((agent) => isModelPickerAgentVisible(agent.id, isDevelopment)).map((agent) => {
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
