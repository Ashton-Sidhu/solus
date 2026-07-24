<script lang="ts">
  import {
    MicrophoneIcon,
    WaveformIcon,
    DownloadSimpleIcon,
  } from "phosphor-svelte";
  import { getSettingsContext, getVoiceModelStore } from "../../contexts";
  import { formatVoiceModelBytes } from "../../contexts/app/voice-model.store.svelte";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";

  const theme = getSettingsContext();
  const voiceModel = getVoiceModelStore();

  const silenceOptions: { label: string; value: number }[] = [
    { label: "1s", value: 1000 },
    { label: "1.5s", value: 1500 },
    { label: "2s", value: 2000 },
    { label: "3s", value: 3000 },
    { label: "4s", value: 4000 },
    { label: "5s", value: 5000 },
    { label: "6s", value: 6000 },
    { label: "8s", value: 8000 },
  ];

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

<div class="flex flex-col">
  <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
    <div class="flex items-center gap-3 min-w-0">
      <MicrophoneIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
      <div>
        <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">
          Auto voice mode<span class="ml-1.5 inline-flex items-center rounded px-1 py-px align-middle text-[0.5313rem] leading-none font-semibold tracking-[0.02em] text-(--solus-accent) uppercase bg-(--solus-accent)/14">Beta</span>
        </div>
        <div class="text-[0.6875rem] text-(--solus-text-tertiary) mt-px">
          Continuously listen and queue voice messages while you work (⌥⇧V)
        </div>
      </div>
    </div>
    <Switch
      checked={theme.voiceModeEnabled}
      onCheckedChange={(next) => theme.update({ voiceModeEnabled: next })}
      size="default"
      aria-label="Toggle auto voice mode"
    />
  </div>

  <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
    <div class="flex items-center gap-3 min-w-0">
      <MicrophoneIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
      <div>
        <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Auto-send transcripts</div>
        <div class="text-[0.6875rem] text-(--solus-text-tertiary) mt-px">
          Send voice messages as soon as they're transcribed, instead of just filling the composer
        </div>
      </div>
    </div>
    <Switch
      checked={theme.autoSendVoiceTranscripts}
      onCheckedChange={(next) => theme.update({ autoSendVoiceTranscripts: next })}
      size="default"
      aria-label="Toggle auto-send for voice transcripts"
    />
  </div>

  <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
    <div class="flex items-center gap-3 min-w-0">
      <WaveformIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
      <div>
        <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Silence threshold</div>
        <div class="text-[0.6875rem] text-(--solus-text-tertiary) mt-px">
          How long to wait after you stop speaking before sending
        </div>
      </div>
    </div>
    <div class="flex min-w-0 flex-wrap items-center rounded-lg border border-(--solus-container-border) overflow-hidden bg-(--solus-input-bg-soft)">
      {#each silenceOptions as opt (opt.value)}
        <button
          type="button"
          onclick={() => theme.update({ vadSilenceMs: opt.value })}
          aria-pressed={theme.vadSilenceMs === opt.value}
          class="min-h-10 min-w-0 px-2.5 py-1.5 text-[0.75rem] transition-colors border-r border-(--solus-container-border) last:border-r-0
            {theme.vadSilenceMs === opt.value
              ? 'bg-(--solus-accent) text-white font-medium'
              : 'text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)'}"
        >
          {opt.label}
        </button>
      {/each}
    </div>
  </div>

  <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
    <div class="flex min-w-0 flex-1 items-center gap-3">
      <DownloadSimpleIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
      <div class="min-w-0 flex-1">
        <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Voice model</div>
        <div class="mt-px truncate text-[0.6875rem] text-(--solus-text-tertiary)">
          Parakeet TDT 0.6B INT8 - {modelStatusLine}
        </div>
        {#if voiceModel.status.state === "downloading" || voiceModel.status.state === "installing"}
          <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-(--solus-input-bg-soft)">
            <div
              class="h-full rounded-full bg-(--solus-accent) transition-[width] duration-300"
              style="width:{voiceModel.status.state === 'installing' ? 100 : voiceModel.progressPct ?? 8}%"
            ></div>
          </div>
        {/if}
      </div>
    </div>
    {#if voiceModel.status.state === "error"}
      <Button variant="outline" size="sm" onclick={() => void voiceModel.retry()}>Retry</Button>
    {/if}
  </div>
</div>
