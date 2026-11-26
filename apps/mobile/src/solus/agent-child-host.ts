import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AgentFeedContext } from "./session-subagent";
import { solus } from "./runtime";

export function remoteAgentChild(hostId: string): AgentFeedContext["child"] {
  return (item) => {
    const head = solus.cloudSessions.headFor(item.sessionId);
    const childHost = head?.lastRunServerId ?? head?.lastRunHostId ?? item.serverId;
    if (!childHost || childHost === hostId) return undefined;
    return {
      environmentId: EnvironmentId.make(childHost),
      threadId: ThreadId.make(item.sessionId),
      label: solus.registry.host(childHost)?.label ?? childHost,
    };
  };
}
