<script lang="ts">
  import { untrack } from "svelte";
  import type { DeviceConfigureRequest, DeviceHostTestResult, SshDeviceHostConfig } from "@solus/contracts/device-types";
  import { sshDeviceHostConfigSchema } from "@solus/contracts/device-types";
  import { Check, Ellipsis, LoaderCircle, Minus, Plus } from "@lucide/svelte";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { Switch } from "../ui/switch";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import DeviceToolVersions from "./DeviceToolVersions.svelte";
  import { emptySshHostDraft, sshHostDraftConfig, type SshHostDraft } from "./lib/device-host-draft";
  import { hostProgressLabel } from "./lib/device-settings";

  /**
   * One host's device settings (docs/native-devices.md): the Settings →
   * Devices page, which the Devices pane's Setup opens. Reading it installs
   * and starts nothing. Each switch shows the value the host stored, never the value
   * asked for: a call that fails leaves the switch where it was and says why.
   * The layout follows T3 Code's Devices settings (`IntegrationsSettings.tsx`,
   * `DeviceHostsSettings.tsx`, MIT): tool versions as chips, one row per host.
   */

  let { serverId }: { serverId: string } = $props();

  $effect(() => {
    const hostId = serverId;
    untrack(() => void devicesStore.load(hostId));
  });

  const deviceState = $derived(devicesStore.state(serverId));
  const unavailable = $derived(devicesStore.unavailable.get(serverId));
  const localHost = $derived(deviceState?.hosts.find((host) => host.kind === "local"));
  const localStatus = $derived(deviceState?.hostStatuses.find((entry) => entry.deviceHostId === localHost?.deviceHostId));
  const sshHosts = $derived(deviceState?.hosts.filter((host) => host.kind === "ssh") ?? []);

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
    const takenIds = deviceState?.hosts.map((host) => host.deviceHostId) ?? [];
    const parsed = sshDeviceHostConfigSchema.safeParse(sshHostDraftConfig(draft, takenIds));
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
      closeEditor();
    });
  }

  function closeEditor() {
    editing = false;
    draft = emptySshHostDraft();
    testResult = null;
  }
</script>

{#snippet toolAction(tool: "hub" | "agent")}
  {@const version = localHost?.tools?.[tool]}
  {#if localHost && version && deviceState?.settings.enabled && !version.installedVersions.includes(version.requiredVersion)}
    <Button size="sm" variant="outline" class="w-full" disabled={busy} onclick={() => void run(() => devicesStore.updateTool(serverId, localHost.deviceHostId, tool))}>
      {version.installedVersions.length ? `Update to ${version.requiredVersion}` : `Install ${version.requiredVersion}`}
    </Button>
  {:else}
    <p class="text-xs text-muted-foreground">Solus installs the required version on this host when you turn this on.</p>
  {/if}
{/snippet}
{#snippet hubAction()}{@render toolAction("hub")}{/snippet}
{#snippet agentAction()}{@render toolAction("agent")}{/snippet}

{#if unavailable}
  <p class="text-workspace-chrome text-muted-foreground" role="status">{unavailable}</p>
{:else if !deviceState}
  <p class="text-workspace-chrome text-muted-foreground" role="status">Checking devices…</p>
{:else}
  {@const settings = deviceState.settings}
  <div class="flex flex-col gap-10" data-testid="device-settings">
    {#if message}<p class="text-workspace-chrome text-destructive" role="alert">{message}</p>{/if}

    <SettingsSection label="Devices">
      <SettingsRow
        label="Device hub"
        description="Show iOS Simulators and Android Emulators beside conversations, on this host or on a device host."
      >
        {#snippet control()}
          <DeviceToolVersions kind="hub" tools={localHost?.tools} error={localHost?.toolInspectionError} action={hubAction} />
          <Switch bind:checked={() => settings.enabled, (enabled) => configure({ enabled })} disabled={busy} aria-label="Device support" />
        {/snippet}
      </SettingsRow>
      {#if settings.enabled && localHost}
        <SettingsRow label="Simulator support">
          {#snippet control()}
            <Button size="sm" variant="outline" disabled={busy} onclick={() => void run(() => devicesStore.inspect(serverId))}>Refresh</Button>
          {/snippet}
          {#snippet body()}
            <div class="flex flex-wrap gap-x-5 gap-y-2 text-xs">
              {#each localHost.platforms as platform (platform.platform)}
                <span class="inline-flex items-start gap-1.5 {platform.available ? '' : 'text-muted-foreground'}">
                  {#if platform.available}<Check class="mt-px size-3 text-emerald-600 dark:text-emerald-400" />{:else}<Minus class="mt-px size-3" />{/if}
                  <span>
                    {platform.platform === "ios" ? "iOS" : "Android"} {platform.available ? "available" : "unavailable"}
                    {#if !platform.available && platform.reason}<span class="block text-muted-foreground">{platform.reason}</span>{/if}
                  </span>
                </span>
              {/each}
            </div>
            {#if localStatus?.status === "failed"}
              <div class="mt-3 flex items-start justify-between gap-3 text-xs text-destructive" role="status">
                <p class="min-w-0 whitespace-pre-wrap break-words">{localStatus.detail ?? "The device hub did not start."}</p>
                <Button size="xs" variant="outline" disabled={busy} onclick={() => void run(() => devicesStore.retryHost(serverId, localStatus.deviceHostId))}>Retry</Button>
              </div>
            {/if}
          {/snippet}
        </SettingsRow>
      {/if}
      <SettingsRow
        label="Agent access"
        description="Let agents start and control simulators and emulators while the device hub is on. Leave this off to keep devices for manual previews only."
      >
        {#snippet control()}
          <DeviceToolVersions kind="agent" tools={localHost?.tools} error={localHost?.toolInspectionError} action={agentAction} />
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
      description="Add a Mac or Linux machine with simulator or emulator runtimes. This host connects to it with SSH keys and sets up the device tools there."
    >
      {#snippet action()}
        <Button size="sm" variant="outline" disabled={busy || editing} onclick={() => (editing = true)}><Plus class="size-3.5" /> Add host</Button>
      {/snippet}
      {#if sshHosts.length === 0 && !editing}
        <p class="px-4 py-3.5 text-[13px] text-muted-foreground">No device hosts.</p>
      {/if}
      {#each sshHosts as host (host.deviceHostId)}
        {@const status = deviceState.hostStatuses.find((entry) => entry.deviceHostId === host.deviceHostId)}
        {@const progress = hostProgressLabel(status?.status)}
        <div class="flex items-center gap-2 px-4 py-3">
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-2">
              <p class="truncate text-sm font-medium">{host.label}</p>
              {#each host.platforms.filter((platform) => platform.available) as platform (platform.platform)}
                <span class="shrink-0 rounded-full border border-border/60 px-1.5 text-[11px] leading-4 text-muted-foreground">{platform.platform === "ios" ? "iOS" : "Android"}</span>
              {/each}
            </div>
            <p class="truncate text-xs text-muted-foreground">{host.deviceHostId}</p>
            {#if status?.status === "failed" && status.detail}
              <details class="mt-1 text-xs text-destructive" role="status">
                <summary class="cursor-pointer">Connection failed</summary>
                <p class="mt-1 whitespace-pre-wrap break-words">{status.detail}</p>
              </details>
            {/if}
          </div>
          {#if progress}
            <span role="status" class="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <LoaderCircle class="size-3 animate-spin motion-reduce:animate-none" />{progress}
            </span>
          {/if}
          <DeviceToolVersions tools={host.tools} error={host.toolInspectionError} />
          {#if status?.status === "failed"}
            <Button size="sm" variant="outline" disabled={busy} onclick={() => void run(() => devicesStore.retryHost(serverId, host.deviceHostId))}>Retry</Button>
          {/if}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Button {...props} size="icon-sm" variant="ghost" disabled={busy} aria-label="{host.label} options"><Ellipsis class="size-4" /></Button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end" sideOffset={6}>
              <DropdownMenu.Item variant="destructive" onSelect={() => void run(() => devicesStore.removeHost(serverId, host.deviceHostId))}>Remove</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </div>
      {/each}
      {#if editing}
        <form class="flex flex-col gap-3 px-4 py-4 text-sm" onsubmit={(event) => { event.preventDefault(); save(); }}>
          <p class="font-medium">Add device host</p>
          <div class="grid gap-3 @min-[30rem]/pane:grid-cols-2">
            <label class="flex flex-col gap-1.5">
              <span>Name</span>
              <Input autofocus placeholder="Mac mini" bind:value={draft.label} disabled={busy} />
            </label>
            <label class="flex flex-col gap-1.5">
              <span>SSH target</span>
              <Input placeholder="user@host or SSH alias" bind:value={draft.target} disabled={busy} />
            </label>
          </div>
          <details>
            <summary class="cursor-pointer text-muted-foreground">SSH options</summary>
            <div class="mt-3 grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
              <label class="flex flex-col gap-1.5">
                <span>Identity file</span>
                <Input placeholder="SSH config default" bind:value={draft.identityFile} disabled={busy} />
              </label>
              <label class="flex flex-col gap-1.5">
                <span>Port</span>
                <Input inputmode="numeric" placeholder="Default" bind:value={draft.port} disabled={busy} />
              </label>
            </div>
            <p class="mt-2 text-xs text-muted-foreground">Optional. The identity file is a path on this host.</p>
          </details>
          <div class="rounded-lg border border-border/60">
            <div class="flex items-center justify-between gap-3 px-3 py-2.5">
              <p role="status" class="text-xs text-muted-foreground">
                {testResult ? (testResult.ok ? "Connection checks passed" : `${testResult.checks.filter((check) => !check.ok).length} of ${testResult.checks.length} checks failed`) : "Test the connection before you save. It installs and starts nothing."}
              </p>
              <Button type="button" size="sm" variant="outline" disabled={busy} onclick={test}>Test connection</Button>
            </div>
            {#if testResult}
              <ul class="flex flex-col gap-1 border-t border-border/60 px-3 py-2.5 text-xs">
                {#each testResult.checks as check (check.name)}
                  <li class="flex items-start gap-1.5 {check.ok ? '' : 'text-muted-foreground'}">
                    {#if check.ok}<Check class="mt-px size-3" />{:else}<Minus class="mt-px size-3" />{/if}
                    <span>{check.name}{check.detail ? ` — ${check.detail}` : ""}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
          <div class="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={busy} onclick={closeEditor}>Cancel</Button>
            <Button type="submit" size="sm" disabled={busy}>Save</Button>
          </div>
        </form>
      {/if}
    </SettingsSection>
  </div>
{/if}
