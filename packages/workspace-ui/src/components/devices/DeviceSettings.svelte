<script lang="ts">
  import { untrack } from "svelte";
  import type { DeviceConfigureRequest, DeviceHostTestResult, SshDeviceHostConfig } from "@solus/contracts/device-types";
  import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION, sshDeviceHostConfigSchema } from "@solus/contracts/device-types";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import { emptySshHostDraft, sshHostDraftConfig, type SshHostDraft } from "./lib/device-host-draft";

  /**
   * One host's device settings (docs/native-devices.md): the Settings →
   * Devices page, which the Devices pane's Setup opens. Reading it installs
   * and starts nothing. Each switch shows the value the host stored, never the value
   * asked for: a call that fails leaves the switch where it was and says why.
   */

  let { serverId }: { serverId: string } = $props();

  $effect(() => {
    const hostId = serverId;
    untrack(() => void devicesStore.load(hostId));
  });

  const deviceState = $derived(devicesStore.state(serverId));
  const unavailable = $derived(devicesStore.unavailable.get(serverId));

  let draft = $state<SshHostDraft>(emptySshHostDraft());
  let editing = $state(false);
  let busy = $state(false);
  let message = $state<string | null>(null);
  let testResult = $state<DeviceHostTestResult | null>(null);

  async function run(work: () => Promise<void>) {
    busy = true;
    message = null;
    try {
      await work();
    } catch (cause) {
      message = deviceErrorMessage(cause);
    } finally {
      busy = false;
    }
  }

  function configure(request: DeviceConfigureRequest) {
    void run(() => devicesStore.configure(serverId, request));
  }

  function config(): SshDeviceHostConfig | null {
    const parsed = sshDeviceHostConfigSchema.safeParse(sshHostDraftConfig(draft));
    if (!parsed.success) {
      message = parsed.error.issues[0]?.message ?? "Check the device host fields.";
      return null;
    }
    return parsed.data;
  }

  function test() {
    const value = config();
    if (!value) return;
    void run(async () => { testResult = await devicesStore.testHost(serverId, value); });
  }

  function save() {
    const value = config();
    if (!value) return;
    void run(async () => {
      await devicesStore.saveHost(serverId, value);
      editing = false;
      draft = emptySshHostDraft();
      testResult = null;
    });
  }
</script>

{#if unavailable}
  <p class="text-workspace-chrome text-muted-foreground" role="status">{unavailable}</p>
{:else if !deviceState}
  <p class="text-workspace-chrome text-muted-foreground" role="status">Checking devices…</p>
{:else}
  {@const settings = deviceState.settings}
  <div class="flex flex-col gap-10" data-testid="device-settings">
    {#if message}<p class="text-workspace-chrome text-destructive" role="alert">{message}</p>{/if}

    <SettingsSection label="Device previews">
      <SettingsRow
        label="Device support"
        description="Show iOS Simulators and Android Emulators beside conversations. The first time you turn this on, Solus installs expo-device-hub {DEVICE_HUB_VERSION} on this host."
      >
        {#snippet control()}
          <Switch bind:checked={() => settings.enabled, (enabled) => configure({ enabled })} disabled={busy} aria-label="Device support" />
        {/snippet}
      </SettingsRow>
      <SettingsRow
        label="Agent access"
        description="On by default. Agents can drive simulators and emulators with agent-device {AGENT_DEVICE_VERSION} while device support is on. Turn it off to keep agents away from devices. You can still preview devices yourself."
      >
        {#snippet control()}
          <Switch bind:checked={() => settings.agentAccessEnabled, (agentAccessEnabled) => configure({ agentAccessEnabled })} disabled={busy || !settings.enabled} aria-label="Agent access" />
        {/snippet}
      </SettingsRow>
      <SettingsRow
        label="Show devices agents open"
        description="Show a device that an agent opens beside the conversation of that agent."
      >
        {#snippet control()}
          <Switch bind:checked={() => settings.autoShowAgentDevices, (autoShowAgentDevices) => configure({ autoShowAgentDevices })} disabled={busy} aria-label="Show devices agents open" />
        {/snippet}
      </SettingsRow>
    </SettingsSection>

    <SettingsSection
      label="Device hosts"
      description="iOS needs macOS with Xcode and a simulator runtime. Android needs the Android SDK with the emulator and command-line tools."
    >
      {#snippet action()}
        <Button size="sm" variant="ghost" disabled={busy} onclick={() => void run(() => devicesStore.inspect(serverId))}>Check versions</Button>
      {/snippet}
      {#each deviceState.hosts as host (host.deviceHostId)}
        {@const status = deviceState.hostStatuses.find((entry) => entry.deviceHostId === host.deviceHostId)}
        <SettingsRow label={host.label} description="{status?.status ?? 'idle'}{status?.detail ? ` — ${status.detail}` : ''}">
          {#snippet control()}
            {#if status?.status === "failed"}
              <Button size="sm" variant="outline" disabled={busy} onclick={() => void run(() => devicesStore.retryHost(serverId, host.deviceHostId))}>Retry</Button>
            {/if}
            {#if host.kind === "ssh"}
              <Button size="sm" variant="ghost" disabled={busy} onclick={() => void run(() => devicesStore.removeHost(serverId, host.deviceHostId))}>Remove</Button>
            {/if}
          {/snippet}
          {#snippet body()}
            <div class="flex flex-col gap-1 text-workspace-chrome">
              {#each host.platforms as platform (platform.platform)}
                <p class={platform.available ? "" : "text-muted-foreground"}>
                  {platform.platform === "ios" ? "iOS" : "Android"}: {platform.available ? "ready" : platform.reason}
                </p>
              {/each}
              {#if host.tools}
                {#each [["hub", "Device hub", host.tools.hub], ["agent", "Agent tools", host.tools.agent]] as const as [tool, label, version] (tool)}
                  <div class="flex items-center justify-between gap-2">
                    <span class="min-w-0 text-muted-foreground">
                      {label}: needs {version.requiredVersion}{version.installedVersions.length ? `, installed ${version.installedVersions.join(", ")}` : ", not installed"}{version.runningVersion ? `, running ${version.runningVersion}` : ""}
                    </span>
                    {#if settings.enabled && !version.installedVersions.includes(version.requiredVersion) && host.kind === "local"}
                      <Button size="xs" variant="outline" disabled={busy} onclick={() => void run(() => devicesStore.updateTool(serverId, host.deviceHostId, tool))}>
                        {version.installedVersions.length ? "Update" : "Install"}
                      </Button>
                    {/if}
                  </div>
                {/each}
              {/if}
              {#if host.toolInspectionError}<p class="text-muted-foreground">{host.toolInspectionError}</p>{/if}
            </div>
          {/snippet}
        </SettingsRow>
      {/each}
      <SettingsRow
        label="SSH device host"
        description="Show the simulators of a Mac or Linux machine that this host reaches with SSH keys. Test connection installs and starts nothing."
        bodyVisible={editing}
      >
        {#snippet control()}
          {#if !editing}
            <Button size="sm" variant="outline" disabled={busy} onclick={() => (editing = true)}>Add SSH device host</Button>
          {/if}
        {/snippet}
        {#snippet body()}
          <div class="flex flex-col gap-3 text-workspace-chrome">
            <div class="grid grid-cols-2 gap-2">
              <input class="rounded-md border border-border bg-background px-2 py-1" placeholder="Id (studio-mac)" bind:value={draft.id} aria-label="Device host id" />
              <input class="rounded-md border border-border bg-background px-2 py-1" placeholder="Name" bind:value={draft.label} aria-label="Device host name" />
              <input class="rounded-md border border-border bg-background px-2 py-1" placeholder="SSH alias or user@host" bind:value={draft.target} aria-label="SSH target" />
              <input class="rounded-md border border-border bg-background px-2 py-1" placeholder="Port (optional)" inputmode="numeric" bind:value={draft.port} aria-label="SSH port" />
              <input class="col-span-2 rounded-md border border-border bg-background px-2 py-1" placeholder="Identity file on this host (optional)" bind:value={draft.identityFile} aria-label="SSH identity file" />
            </div>
            {#if testResult}
              <ul class="flex flex-col gap-0.5">
                {#each testResult.checks as check (check.name)}
                  <li class={check.ok ? "" : "text-muted-foreground"}>{check.ok ? "✓" : "✗"} {check.name}{check.detail ? ` — ${check.detail}` : ""}</li>
                {/each}
              </ul>
            {/if}
            <div class="flex gap-2">
              <Button size="sm" variant="outline" disabled={busy} onclick={test}>Test connection</Button>
              <Button size="sm" disabled={busy} onclick={save}>Save</Button>
              <Button size="sm" variant="ghost" disabled={busy} onclick={() => { editing = false; testResult = null; }}>Cancel</Button>
            </div>
          </div>
        {/snippet}
      </SettingsRow>
    </SettingsSection>
  </div>
{/if}
