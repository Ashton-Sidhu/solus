<script lang="ts">
  /**
   * Where this host sends its own telemetry.
   *
   * A host setting, not a device one: the exporter runs beside the server, so a
   * phone on this page is configuring the machine it is connected to. That is
   * also why nothing here is desktop-only.
   *
   * Standard `OTEL_EXPORTER_OTLP_*` environment variables still win. When they
   * are set the form goes read-only and says so, rather than offering controls
   * that would not take effect — a switch that lies about what it does is worse
   * than a switch that is honestly unavailable.
   */
  import { untrack } from "svelte";
  import type { HostApi } from "@client-core/host-api";
  import { getOtelSettingsStore } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { Switch } from "../ui/switch";
  import SettingsRow from "./SettingsRow.svelte";
  import SettingsSection from "./SettingsSection.svelte";

  interface Props {
    serverId: string;
    api: HostApi;
    searchQuery?: string;
  }

  let { serverId, api, searchQuery = "" }: Props = $props();

  const store = getOtelSettingsStore();
  const snapshot = $derived(store.snapshotFor(serverId));
  const settings = $derived(snapshot?.settings ?? null);
  const error = $derived(store.errorFor(serverId));
  const managed = $derived(snapshot?.managedByEnvironment === true);
  /** Nothing is editable before the host has answered, or once its environment
   *  has taken the decision away from this page. */
  const locked = $derived(!snapshot || managed);

  // Endpoint and headers are typed, so they are drafts until saved rather than
  // firing an RPC per keystroke. Every other control is a switch and saves on
  // change, which is what a switch promises.
  let endpointDraft = $state("");
  let headersDraft = $state("");
  let savedEndpoint = $state<string | null>(null);
  let savedHeaders = $state<string | null>(null);

  $effect(() => {
    const targetServerId = serverId;
    const targetApi = api;
    untrack(() => {
      void store.load({ serverId: targetServerId, api: targetApi }).catch(() => {});
    });
  });

  $effect(() => {
    const endpoint = settings?.endpoint ?? "";
    if (endpoint === savedEndpoint) return;
    endpointDraft = endpoint;
    savedEndpoint = endpoint;
  });

  $effect(() => {
    const headers = settings?.headers ?? "";
    if (headers === savedHeaders) return;
    headersDraft = headers;
    savedHeaders = headers;
  });

  const connectionDirty = $derived(
    endpointDraft.trim() !== (settings?.endpoint ?? "") ||
      headersDraft.trim() !== (settings?.headers ?? ""),
  );

  const activeSignals = $derived(
    snapshot
      ? (["logs", "metrics", "traces"] as const).filter((signal) => snapshot.active[signal])
      : [],
  );

  const statusLine = $derived.by(() => {
    if (!snapshot) return "Reading this host's telemetry settings…";
    if (activeSignals.length === 0) {
      return managed
        ? "This host's environment sets no OTLP endpoint, so nothing is exported."
        : "Nothing is exported. Telemetry stays in this host's local database.";
    }
    const list = activeSignals.join(", ");
    return managed
      ? `Exporting ${list}, configured by this host's environment variables.`
      : `Exporting ${list}.`;
  });

  const settingItems = [
    { id: "export", keywords: ["otel", "opentelemetry", "otlp", "export", "telemetry", "enable", "collector"] },
    { id: "endpoint", keywords: ["otel", "otlp", "endpoint", "url", "collector", "headers", "auth", "token", "api key"] },
    { id: "signals", keywords: ["otel", "otlp", "logs", "metrics", "traces", "spans", "signal"] },
  ];

  function isVisible(id: string): boolean {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return settingItems.find((item) => item.id === id)?.keywords.some((keyword) => keyword.includes(query)) ?? true;
  }

  const anyVisible = $derived(settingItems.some((item) => isVisible(item.id)));

  async function update(patch: Parameters<HostApi["otelSettingsUpdate"]>[0]): Promise<void> {
    await store.update({ serverId, api }, patch).catch(() => {});
    requestInputFocus();
  }

  function saveConnection(): void {
    void update({ endpoint: endpointDraft.trim(), headers: headersDraft.trim() });
  }
</script>

<SettingsSection label="OpenTelemetry" visible={isVisible("export")}>
  <SettingsRow
    label="Export telemetry"
    description={statusLine}
    visible={isVisible("export")}
  >
    {#snippet control()}
      <Switch
        checked={settings?.enabled === true}
        disabled={locked || (settings?.endpoint ?? "") === ""}
        onCheckedChange={(enabled) => void update({ enabled })}
        aria-label="Export telemetry over OTLP"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Collector endpoint"
    description="Base OTLP/HTTP address. Solus appends the signal path, so give the root — https://otlp.example.com, not its /v1/traces."
    visible={isVisible("endpoint")}
    bodyVisible={isVisible("endpoint")}
  >
    {#snippet body()}
      <div class="space-y-2">
        <Input
          bind:value={endpointDraft}
          disabled={locked}
          type="url"
          spellcheck={false}
          placeholder="https://otlp.example.com"
          aria-label="OTLP collector endpoint"
        />
        <Input
          bind:value={headersDraft}
          disabled={locked}
          spellcheck={false}
          placeholder="Authorization=Bearer …, x-tenant=acme"
          aria-label="OTLP headers"
        />
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="min-w-52 flex-1 text-pretty text-xs text-muted-foreground">
            {#if managed}
              This host sets OTEL_EXPORTER_OTLP_* environment variables. They take
              precedence, so these fields are read-only until they are unset.
            {:else}
              Headers are comma-separated key=value pairs — how a hosted collector
              authorizes this host. They are stored on the host, never on this device.
            {/if}
          </p>
          <Button size="sm" disabled={locked || !connectionDirty} onclick={saveConnection}>
            Save endpoint
          </Button>
        </div>
      </div>
    {/snippet}
  </SettingsRow>
</SettingsSection>

<SettingsSection label="Signals" visible={isVisible("signals")}>
  <SettingsRow
    label="Traces"
    description="Every span Solus records: turns, tool calls, waits, and the dispatch steps behind setup. The same trace ids Insights shows."
    visible={isVisible("signals")}
  >
    {#snippet control()}
      <Switch
        checked={settings?.exportTraces === true}
        disabled={locked}
        onCheckedChange={(exportTraces) => void update({ exportTraces })}
        aria-label="Export traces"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Logs"
    description="This host's structured log records, the same entries written to dev.log."
    visible={isVisible("signals")}
  >
    {#snippet control()}
      <Switch
        checked={settings?.exportLogs === true}
        disabled={locked}
        onCheckedChange={(exportLogs) => void update({ exportLogs })}
        aria-label="Export logs"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Metrics"
    description="Duration histograms recorded by timed operations."
    visible={isVisible("signals")}
  >
    {#snippet control()}
      <Switch
        checked={settings?.exportMetrics === true}
        disabled={locked}
        onCheckedChange={(exportMetrics) => void update({ exportMetrics })}
        aria-label="Export metrics"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>

{#if error}
  <p class="px-1 text-xs text-(--failure)">{error}</p>
{/if}

{#if !anyVisible}
  <div class="py-8 text-center text-sm text-(--solus-text-tertiary)">
    No settings match your search
  </div>
{/if}
