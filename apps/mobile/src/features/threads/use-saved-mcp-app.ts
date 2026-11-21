import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { HostApi } from "@solus/client-core/host-api";
import { mcpAppsFor, type McpAppRead } from "@solus/client-core/mcp-app-store";
import type { McpAppRequest } from "@solus/contracts/mcp-apps";

const IDLE: McpAppRead = { phase: "idle" };

/** The saved MCP App of one activity, loaded and followed; `idle` while either value is null. */
export function useSavedMcpApp(api: HostApi | null | undefined, request: McpAppRequest | null) {
  const apps = useMemo(() => (api ? mcpAppsFor(api) : null), [api]);
  const subscribe = useCallback((listener: () => void) => (apps && request ? apps.subscribe(request, listener) : () => {}), [apps, request]);
  const read = useCallback(() => (apps && request ? apps.read(request) : IDLE), [apps, request]);
  const app = useSyncExternalStore(subscribe, read, read);
  const reload = useCallback(() => {
    if (apps && request) void apps.load(request);
  }, [apps, request]);
  useEffect(reload, [reload]);
  return { app, reload };
}
