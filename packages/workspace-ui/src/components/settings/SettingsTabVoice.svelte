<script lang="ts">
  import { getSettingsContext, hosts } from "../../contexts";
  import { formatVoiceModelBytes } from "./lib/voice-model-bytes";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import SettingsSelect from "./SettingsSelect.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import { supportsSettingsSurface } from "@solus/client-core/host-capabilities";
  import SettingsHostUnsupported from "./SettingsHostUnsupported.svelte";

  interface Props {
    serverId: string;
    hostLabel: string;
  }
  let { serverId, hostLabel }: Props = $props();

  const settings = getSettingsContext();
  const host = $derived(hosts.get(serverId));
  const capabilities = $derived(host.capabilityRecord);
  const isSupported = $derived(supportsSettingsSurface(capabilities, "voice"));
  // Read only where the host transcribes: asking a server that cannot is an error row.
  const modelStatus = $derived(isSupported ? host.voiceStatus : { state: "checking" as const });
  const modelProgressPct = $derived(isSupported ? host.voiceProgressPct : null);

  const silenceOptions = [1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000].map((ms) => ({
    value: String(ms),
    label: `${ms / 1000}s`,
  }));

  const downloadInFlight = $derived(
    modelStatus.state === "downloading" || modelStatus.state === "installing",
  );

  const modelStatusLine = $derived.by(() => {
    const status = modelStatus;
    if (status.state === "ready") return "Ready";
    if (status.state === "installing") return "Installing...";
    if (status.state === "error") return status.error ? `Failed: ${status.error}` : "Download failed";
    if (status.state === "downloading") {
      const received = formatVoiceModelBytes(status.receivedBytes);
      const total = formatVoiceModelBytes(status.totalBytes);
      return total ? `Downloading - ${received} / ${total}` : "Downloading...";
    }
    return "Checking...";
  });
</script>

{#if capabilities === undefined}
  <div class="py-10 text-center text-workspace-chrome text-(--solus-text-tertiary)" role="status">
    Checking voice support…
  </div>
{:else if !isSupported}
  <SettingsHostUnsupported feature="Voice features" {hostLabel} />
{:else}
<SettingsSection label="Dictation">
  <!-- Dictation transcribes on this device when it has a host, else on the Run on
       host (`hosts.transcription`). The selected host above frames only the
       model-status surface below. -->
  <SettingsRow
    label="Auto-send transcripts"
    description="Send voice messages when transcribed, not just fill the composer."
  >
    {#snippet control()}
      <Switch
        checked={settings.autoSendVoiceTranscripts}
        onCheckedChange={(enabled) => settings.setDevice("autoSendVoiceTranscripts", enabled)}
        size="default"
        aria-label="Toggle auto-send for voice transcripts"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Silence threshold"
    description="Wait after you stop speaking before sending."
  >
    {#snippet control()}
      <SettingsSelect
        options={silenceOptions}
        value={String(settings.vadSilenceMs)}
        onSelect={(value) => settings.setDevice("vadSilenceMs", Number(value))}
        ariaLabel="Silence threshold"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>

<!-- Passed to SettingsRow only in the states they apply to, so the row doesn't
     reserve empty slots for a retry button or progress bar that isn't there. -->
{#snippet retryDownload()}
  <Button
    variant="outline"
    size="sm"
    onclick={() => void host.retryVoiceModel()}
  >Retry</Button>
{/snippet}

{#snippet downloadProgress()}
  <div class="h-1.5 overflow-hidden rounded-full bg-(--solus-input-bg-soft)">
    <div
      class="h-full rounded-full bg-(--solus-accent) transition-[width] duration-300"
      style="width:{modelStatus.state === 'installing' ? 100 : modelProgressPct ?? 8}%"
    ></div>
  </div>
{/snippet}

<SettingsSection label="Model">
  <SettingsRow
    label="Voice model"
    description="Parakeet TDT 0.6B INT8 — {modelStatusLine}"
    control={modelStatus.state === "error" ? retryDownload : undefined}
    body={downloadInFlight ? downloadProgress : undefined}
  />
</SettingsSection>
{/if}
