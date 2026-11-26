<script lang="ts">
  /** The value to copy by hand when the clipboard does not work: in a read-only
   *  field, selected, with a QR code when another device can open it. */
  import { onMount } from "svelte";
  import { X as CloseIcon } from "@lucide/svelte";
  import { useScope } from "../../../lib/keybindings/use-keybinding.svelte";
  import { Button } from "../../ui/button";
  import { COPIED_VALUE_TITLES, copiedValueQr, type CopiedValueKind } from "../lib/outside-apps-share";
  import OutsideAppsQr from "./OutsideAppsQr.svelte";

  interface Props {
    kind: CopiedValueKind;
    value: string;
    onClose: () => void;
  }

  let { kind, value, onClose }: Props = $props();

  let fieldEl = $state<HTMLTextAreaElement | null>(null);
  const title = $derived(COPIED_VALUE_TITLES[kind]);
  const qrValue = $derived(copiedValueQr(value));

  onMount(() => {
    fieldEl?.focus();
    fieldEl?.select();
  });

  useScope("modal-dialog", { exclusive: true, pre: true });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  data-solus-ui
  class="pointer-events-auto fixed inset-0 z-[10009] flex items-start justify-center modal-backdrop px-4 pt-[18vh]"
  role="presentation"
  onclick={(event) => { if (event.target === event.currentTarget) onClose(); }}
  onkeydown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
>
  <div
    class="flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-3 rounded-2xl border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) p-5 text-workspace-chrome text-(--solus-text-primary) shadow-[shadow:var(--solus-popover-shadow)]"
    role="dialog"
    aria-modal="true"
    aria-labelledby="outside-apps-copy-fallback-title"
    data-testid="outside-apps-copy-fallback"
  >
    <div class="flex items-start justify-between gap-3">
      <h2 id="outside-apps-copy-fallback-title" class="text-base font-medium">{title}</h2>
      <Button variant="ghost" size="icon-sm" class="-mt-1 -mr-2 shrink-0 text-(--solus-text-tertiary)" aria-label="Close" onclick={onClose}>
        <CloseIcon size={16} />
      </Button>
    </div>
    <p class="text-(--solus-text-secondary)">Clipboard copy is not available here. Copy this value by hand.</p>
    <textarea
      bind:this={fieldEl}
      readonly
      rows={Math.min(4, Math.ceil(value.length / 44))}
      aria-label={title}
      class="w-full resize-none rounded-lg border border-border bg-(--solus-surface-hover) px-3 py-2 font-mono text-chrome-dense break-all text-(--solus-text-primary) outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      {value}
      onfocus={(event) => event.currentTarget.select()}
    ></textarea>
    {#if qrValue}
      <OutsideAppsQr value={qrValue} label={`QR code of the ${title.toLowerCase()}`} />
    {/if}
    <div class="flex justify-end">
      <Button size="sm" onclick={onClose}>Done</Button>
    </div>
  </div>
</div>
