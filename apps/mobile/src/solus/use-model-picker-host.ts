import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  agentForProject,
  agentProjectInstance,
  selectedProviderInstance,
} from "@solus/contracts/provider-instance-models";
import type { HostApi } from "@solus/client-core/host-api";
import type { AgentId } from "@solus/contracts/types";
import type { ModelOption } from "../lib/modelOptions";
import { modelFavoriteKey } from "../features/threads/thread-settings-sheet-state";
import { modelInstanceId } from "./model-picker-catalog";
import { solus } from "./runtime";
import { useHostSettingsRead } from "./use-host-settings-read";

const readHostUpdates = (api: HostApi) => api.hostUpdateStatus();

export function useModelPickerHost(host: string, cwd: string) {
  const connection = useSyncExternalStore(
    solus.connections.changes.subscribe,
    () => solus.connections.connection(host),
  );
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!connection) return () => {};
      const unsubscribe = connection.facts.subscribe((key) => {
        if (key === "machine" || key === "policy") notify();
      });
      connection.facts.ensure("machine");
      connection.facts.ensure("policy");
      return unsubscribe;
    },
    [connection],
  );
  const machine = useSyncExternalStore(subscribe, () =>
    connection?.facts.get("machine"),
  );
  const policies = useSyncExternalStore(subscribe, () =>
    connection?.facts.value("policy"),
  );
  const updates = useHostSettingsRead(
    host,
    readHostUpdates,
    "host.updateStatusChanged",
  );
  const agents = useMemo(
    () =>
      machine?.state === "ready"
        ? machine.value.agents.map((agent) => agentForProject(agent, cwd))
        : undefined,
    [machine, cwd],
  );
  const favorites = useMemo(
    () =>
      new Set(
        agents?.flatMap((agent) =>
          (agentProjectInstance(agent, cwd)?.favoriteModels ?? []).map(
            (model) => modelFavoriteKey(modelInstanceId(agent.id), model),
          ),
        ),
      ),
    [agents, cwd],
  );
  const setModelPreference = async (
    option: ModelOption,
    key: "favoriteModels" | "hiddenModels",
    enabled: boolean,
  ) => {
    if (!connection)
      throw new Error("Reconnect to the host to change model preferences.");
    const currentAgent = agents?.find(
      (agent) => modelInstanceId(agent.id) === option.selection.instanceId,
    );
    if (currentAgent?.id !== "claude-code" && currentAgent?.id !== "codex")
      return;
    const currentInstance = agentProjectInstance(currentAgent, cwd);
    const snapshot = await connection.api.providerInstancesGet();
    const { instance } = selectedProviderInstance(
      snapshot,
      currentAgent.id,
      cwd,
    );
    if (!instance || instance.id !== currentInstance?.id) {
      throw new Error(
        "The project's provider changed. Open the model picker again.",
      );
    }
    const { model } = option.selection;
    const models = new Set(instance[key]);
    if (enabled) models.add(model);
    else models.delete(model);
    await connection.api.providerInstancesWrite({
      expectedRevision: snapshot.revision,
      change: { kind: "save", instance: { ...instance, [key]: [...models] } },
    });
    await connection.facts.refresh("machine");
    await connection.facts.when("machine");
  };

  return {
    agents,
    policies,
    emptyMessage: !connection
      ? "Reconnect to the host to see models."
      : machine?.state === "loading"
        ? "Loading models…"
        : machine?.state === "error"
          ? machine.message
          : undefined,
    providerNotice: (agent: AgentId) => {
      const update = updates.data?.providers.find(
        (entry) => entry.agent === agent,
      )?.check;
      return update?.kind === "available"
        ? `Provider update available (${update.latestVersion}).`
        : undefined;
    },
    favoriteKeys: favorites,
    canFavorite: (option: ModelOption) =>
      !!option.selection.model &&
      !!agents?.some(
        (agent) =>
          modelInstanceId(agent.id) === option.selection.instanceId &&
          agentProjectInstance(agent, cwd),
      ),
    setFavorite: (option: ModelOption, favorite: boolean) =>
      setModelPreference(option, "favoriteModels", favorite),
    setHidden: (option: ModelOption, hidden: boolean) =>
      setModelPreference(option, "hiddenModels", hidden),
    refresh: async (force: boolean) => {
      if (!connection)
        throw new Error("Reconnect to the host to refresh models.");
      if (force) {
        const result = await connection.api.modelProfilesRefresh();
        if (result.error) throw new Error(result.error);
      } else {
        await connection.api.modelProfilesCheck().catch(() => null);
      }
      await connection.facts.refresh(
        "machine",
        force ? {} : { maxAgeMs: 30_000 },
      );
      await connection.facts.when("machine");
    },
  };
}

export function isPickerProvider(provider: AgentId): boolean {
  return (
    provider === "claude-code" ||
    provider === "codex" ||
    (__DEV__ && provider === "replay")
  );
}
