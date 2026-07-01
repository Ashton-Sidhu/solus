<script lang="ts">
  import {
    MicrophoneIcon,
    WaveformIcon,
  } from "phosphor-svelte";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";

  const theme = getSettingsContext();

  const silenceOptions: { label: string; value: number }[] = [
    { label: "1s", value: 1000 },
    { label: "2s", value: 2000 },
    { label: "3s", value: 3000 },
    { label: "4s", value: 4000 },
    { label: "5s", value: 5000 },
    { label: "6s", value: 6000 },
    { label: "8s", value: 8000 },
  ];
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
          Continuously listen and send voice input after Claude responds (⌥⇧V)
        </div>
      </div>
    </div>
    {@render toggle(
      theme.voiceModeEnabled,
      (next) => theme.update({ voiceModeEnabled: next }),
      "Toggle auto voice mode",
    )}
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
          class="min-w-0 px-2.5 py-1.5 text-[0.75rem] transition-colors border-r border-(--solus-container-border) last:border-r-0
            {theme.vadSilenceMs === opt.value
              ? 'bg-(--solus-accent) text-white font-medium'
              : 'text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)'}"
        >
          {opt.label}
        </button>
      {/each}
    </div>
  </div>

</div>

{#snippet toggle(checked: boolean, onChange: (next: boolean) => void, label: string)}
  <button
    type="button"
    aria-label={label}
    aria-pressed={checked}
    onclick={() => onChange(!checked)}
    class="relative w-[2.375rem] h-[1.375rem] rounded-[0.6875rem] border cursor-pointer shrink-0 [transition:background_0.2s_ease,border-color_0.2s_ease]
      {checked ? 'bg-(--solus-accent) border-(--solus-accent)' : 'bg-(--solus-input-bg-soft) border-(--solus-container-border)'}"
  >
    <span class="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-lg bg-white [transition:left_0.2s_ease] shadow-[0_1px_3px_rgba(0,0,0,0.1)]" style="left:{checked ? 20 : 3}px"></span>
  </button>
{/snippet}
