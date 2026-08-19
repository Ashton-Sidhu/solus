<script lang="ts">
  import {
    getSettingsContext,
    getVoiceModelStore,
    hostCapabilitiesStore,
  } from "../../contexts";
  import { formatVoiceModelBytes } from "../../contexts/app/voice-model.store.svelte";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import SegmentedControl from "../ui/SegmentedControl.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import type { HostApi } from "@solus/client-core/host-api";
  import { supportsSettingsSurface } from "@solus/client-core/host-capabilities";
  import SettingsHostUnsupported from "./SettingsHostUnsupported.svelte";

  interface Props {
    serverId: string;
    api: HostApi;
    hostLabel: string;
  }
  let { serverId, api, hostLabel }: Props = $props();

  const settings = getSettingsContext();
  const voiceModel = getVoiceModelStore();
  const modelStatus = $derived(voiceModel.statusFor(serverId));
  const modelProgressPct = $derived(voiceModel.progressFor(serverId));
  const capabilities = $derived(hostCapabilitiesStore.for(serverId));
  const isSupported = $derived(supportsSettingsSurface(capabilities, "voice"));

  $effect(() => {
    void hostCapabilitiesStore.load(serverId);
    if (isSupported) void voiceModel.refreshFor(serverId, api);
  });

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
  <div class="py-10 text-center text-sm text-(--solus-text-tertiary)" role="status">
    Checking voice support…
  </div>
{:else if !isSupported}
  <SettingsHostUnsupported feature="Voice features" {hostLabel} />
{:else}
<SettingsSection label="Dictation">
  <!-- Transcription is client-adjacent and remains primary-host by design. The
       selected host above frames only the model-status surface below. -->
  <SettingsRow
    label="Auto-send transcripts"
    description="Send voice messages as soon as they're transcribed, instead of just filling the composer."
  >
    {#snippet control()}
      <Switch
        checked={settings.autoSendVoiceTranscripts}
        onCheckedChange={(enabled) => settings.update({ autoSendVoiceTranscripts: enabled })}
        size="default"
        aria-label="Toggle auto-send for voice transcripts"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Silence threshold"
    description="How long to wait after you stop speaking before sending."
  >
    {#snippet control()}
      <SegmentedControl
        options={silenceOptions}
        isActive={(value) => settings.vadSilenceMs === Number(value)}
        onSelect={(value) => settings.update({ vadSilenceMs: Number(value) })}
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
    onclick={() => void voiceModel.retryFor(serverId, api)}
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
