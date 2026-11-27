import type { ClaudeAutoModeTarget } from "@solus/contracts/claude-auto-mode";
import { hostQuery } from "./host-query";
import { solus } from "./runtime";

/** The Solus host owns the provider instance, its settings, and the checkout. */
export const claudeAutoModeQuery = hostQuery((hostId, input: ClaudeAutoModeTarget) => {
  const connection = solus.connections.connection(hostId);
  if (connection?.state.readiness !== "ready") throw new Error("Reconnect to this environment.");
  return connection.api.claudeAutoModeRestriction(input);
}, 5_000);
