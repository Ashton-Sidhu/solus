<script lang="ts">
  import { hosts } from "../../contexts/hosts/hosts.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";

  const host = $derived(hosts.transcription);
  const status = $derived(host?.capabilityRecord?.voiceModel === true ? host.voiceStatus : null);
  const progress = $derived(host?.voiceProgressPct ?? null);
</script>

{#if status?.state === "downloading" || status?.state === "installing" || status?.state === "error"}
  <div class="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-(--solus-menu-hairline) bg-(--solus-container-bg) px-4 py-2 text-workspace-chrome text-(--solus-text-secondary)">
    <span role="status">
      {#if status.state === "downloading"}
        Downloading voice model
      {:else if status.state === "installing"}
        Installing voice model…
      {:else}
        Voice model download failed.
      {/if}
    </span>
    {#if status.state === "downloading"}
      {#if progress !== null}
        <progress class="h-1.5 w-24 accent-(--solus-accent)" value={progress} max="100" aria-label="Voice model download"></progress>
        <span class="tabular-nums" aria-hidden="true">{progress}%</span>
      {/if}
      <span class="text-(--solus-text-tertiary)">You can keep typing.</span>
    {:else if status.state === "error"}
      <button
        type="button"
        class="rounded px-2 py-1 font-medium text-(--solus-accent) hover:bg-(--solus-surface-hover) focus-visible:outline-2 focus-visible:outline-(--solus-accent)"
        onclick={() => {
          void host?.retryVoiceModel();
          requestInputFocus();
        }}
      >Retry voice model download</button>
    {/if}
  </div>
{/if}
