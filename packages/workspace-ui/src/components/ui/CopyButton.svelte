<script lang="ts">
  import { Copy as CopyIcon, Check as CheckIcon } from "@lucide/svelte";
  import { onDestroy } from "svelte";
  import { requestInputFocus } from "../../lib/inputFocus";

  interface Props {
    /** A callback defers formatting and history loading until the click. */
    getText?: () => string | Promise<string>;
    text?: string;
    onError?: (error: Error) => void;
    refocusInput?: boolean;
    /** Tooltip naming what gets copied, for callers outside a message. */
    title?: string;
    /** Show only the icon when the surrounding UI already identifies the value. */
    iconOnly?: boolean;
  }
  let { text = "", getText, title = "Copy response", iconOnly = false, onError, refocusInput = true }: Props = $props();

  let copied = $state(false);
  let copying = $state(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(resetTimer));

  async function handleCopy() {
    if (copying) return;
    copying = true;
    try {
      const value = getText ? await getText() : text;
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        // navigator.clipboard is unavailable on non-secure origins (e.g. the web
        // client served over plain http on a LAN). Fall back to execCommand.
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          if (!document.execCommand("copy")) throw new Error("Clipboard access was denied.");
        } finally {
          ta.remove();
        }
      }
      copied = true;
      if (refocusInput) requestInputFocus();
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => (copied = false), 1500);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error("Could not copy text."));
    } finally {
      copying = false;
    }
  }
</script>

<button
  type="button"
  disabled={copying}
  aria-busy={copying}
  onclick={handleCopy}
  class="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border-none bg-transparent text-xs text-(--solus-text-tertiary) {iconOnly
    ? 'size-7 justify-center p-0'
    : 'px-1.5 py-0.5'}"
  title={copied ? "Copied" : title}
  aria-label={copied ? "Copied" : iconOnly ? title : undefined}
>
  <span class="relative inline-flex" aria-hidden="true">
    <CopyIcon
      size={iconOnly ? 13 : 11}
      class="absolute transition-opacity duration-150 motion-reduce:transition-none"
      style="opacity:{copied ? 0 : 1}"
    />
    <CheckIcon
      size={iconOnly ? 13 : 11}
      class="text-(--solus-status-complete) transition-opacity duration-150 motion-reduce:transition-none"
      style="opacity:{copied ? 1 : 0}"
    />
  </span>
  {#if !iconOnly}
    <span>{copied ? "Copied" : "Copy"}</span>
  {/if}
</button>
