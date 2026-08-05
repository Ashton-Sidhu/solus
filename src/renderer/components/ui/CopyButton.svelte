<script lang="ts">
  import { CopyIcon, CheckIcon } from "phosphor-svelte";
  import { requestInputFocus } from "../../lib/inputFocus";

  interface Props {
    text: string;
    /** Tooltip naming what gets copied, for callers outside a message. */
    title?: string;
    /** Show only the icon when the surrounding UI already identifies the value. */
    iconOnly?: boolean;
  }
  let { text, title = "Copy response", iconOnly = false }: Props = $props();

  let copied = $state(false);

  async function handleCopy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // navigator.clipboard is unavailable on non-secure origins (e.g. the web
        // client served over plain http on a LAN). Fall back to execCommand.
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      copied = true;
      requestInputFocus();
      setTimeout(() => (copied = false), 1500);
    } catch {}
  }
</script>

<button
  onclick={handleCopy}
  class="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border-none text-[0.6875rem] transition-colors {iconOnly
    ? 'size-7 justify-center p-0'
    : 'px-1.5 py-0.5'}"
  class:bg-(--solus-status-complete-bg)={copied}
  class:text-(--solus-status-complete)={copied}
  class:bg-transparent={!copied}
  class:text-(--solus-text-tertiary)={!copied}
  {title}
  aria-label={iconOnly ? title : undefined}
>
  <span class="icon-swap">
    <CopyIcon size={iconOnly ? 13 : 11} style="position:absolute;transition:opacity 0.2s cubic-bezier(0.2,0,0,1),transform 0.2s cubic-bezier(0.2,0,0,1),filter 0.2s cubic-bezier(0.2,0,0,1);opacity:{copied ? 0 : 1};transform:scale({copied ? 0.25 : 1});filter:blur({copied ? '0.25rem' : '0'})" />
    <CheckIcon size={iconOnly ? 13 : 11} style="transition:opacity 0.2s cubic-bezier(0.2,0,0,1),transform 0.2s cubic-bezier(0.2,0,0,1),filter 0.2s cubic-bezier(0.2,0,0,1);opacity:{copied ? 1 : 0};transform:scale({copied ? 1 : 0.25});filter:blur({copied ? '0' : '0.25rem'})" />
  </span>
  {#if !iconOnly}
    <span>{copied ? "Copied" : "Copy"}</span>
  {/if}
</button>
