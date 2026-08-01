<script lang="ts">
  import { getSettingsContext, getVoiceModelStore } from "../../contexts";
  import { formatVoiceModelBytes } from "../../contexts/app/voice-model.store.svelte";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import SegmentedControl from "../ui/SegmentedControl.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";

  const settings = getSettingsContext();
  const voiceModel = getVoiceModelStore();

  const silenceOptions = [1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000].map((ms) => ({
    value: String(ms),
    label: `${ms / 1000}s`,
  }));

  const downloadInFlight = $derived(
    voiceModel.status.state === "downloading" || voiceModel.status.state === "installing",
  );

  const modelStatusLine = $derived.by(() => {
    const status = voiceModel.status;
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

<SettingsSection label="Dictation">
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
  <Button variant="outline" size="sm" onclick={() => void voiceModel.retry()}>Retry</Button>
{/snippet}

{#snippet downloadProgress()}
  <div class="h-1.5 overflow-hidden rounded-full bg-(--solus-input-bg-soft)">
    <div
      class="h-full rounded-full bg-(--solus-accent) transition-[width] duration-300"
      style="width:{voiceModel.status.state === 'installing' ? 100 : voiceModel.progressPct ?? 8}%"
    ></div>
  </div>
{/snippet}

<SettingsSection label="Model">
  <SettingsRow
    label="Voice model"
    description="Parakeet TDT 0.6B INT8 — {modelStatusLine}"
    control={voiceModel.status.state === "error" ? retryDownload : undefined}
    body={downloadInFlight ? downloadProgress : undefined}
  />
</SettingsSection>
