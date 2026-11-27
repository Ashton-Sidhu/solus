<script lang="ts">
  /** One value to copy in "Use Solus from your other apps": its label, the value, and a
   *  copy button whose icon is a check for 1.5 s after a copy. */
  import { Check as CheckIcon, Copy as CopyIcon } from "@lucide/svelte";
  import { Button } from "../../ui/button";
  import type { CopiedValueKind } from "../lib/outside-apps-share";
  import { outsideApps } from "./outside-apps.svelte";

  interface Props {
    label: string;
    value: string;
    /** What the value is, for the dialog that shows it when the clipboard does not work. */
    kind: CopiedValueKind;
    /** After a copy that landed: "Set up another way" marks its step done. */
    onCopied?: () => void;
  }

  let { label, value, kind, onCopied }: Props = $props();

  let isCopied = $state(false);
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  async function copy() {
    if (!(await outsideApps.copy(kind, value))) return;
    isCopied = true;
    onCopied?.();
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => (isCopied = false), 1500);
  }

  $effect(() => () => {
    if (resetTimer) clearTimeout(resetTimer);
  });
</script>

<div class="flex min-w-0 items-center gap-2 rounded-lg bg-muted py-1.5 pr-1.5 pl-3">
  <span class="shrink-0 text-chrome-dense text-(--solus-text-secondary)">{label}</span>
  <span class="min-w-0 flex-1 truncate text-chrome-dense text-(--solus-text-primary) select-text">{value}</span>
  <Button
    variant="ghost"
    size="icon-sm"
    class="shrink-0 text-(--solus-text-tertiary)"
    onclick={() => void copy()}
    aria-label={`Copy ${label.toLowerCase()}`}
  >
    {#if isCopied}
      <CheckIcon size={14} class="text-(--solus-status-complete)" />
    {:else}
      <CopyIcon size={14} />
    {/if}
  </Button>
</div>
