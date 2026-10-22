<script lang="ts">
  import { Copy as CopyIcon } from "@lucide/svelte";
  import { plainTerminalText, terminalLines } from "@solus/client-core/terminal-text";
  import { copyText, toasts } from "../../../lib/toasts";
  import { cn } from "../../../lib/tw";
  import { Button } from "../button";

  /**
   * A command's output as the terminal showed it, in the theme's own terminal
   * (`--solus-terminal-*`): the code panel's fill, mono, every line as
   * printed, the colours the tool chose, and an error or warning line in its
   * tone when the tool printed no colour. Wrapped so a long line stays in the
   * pane; the caller sets the height it may take before it scrolls. Shared
   * by a background command's wake, a device build's raw log, and the command
   * a permission card asks about.
   */
  interface Props {
    output: string;
    /** The panel's name for assistive technology. */
    label: string;
    /** Earlier output was dropped: say so above the first line. */
    truncated?: boolean;
    /** The command still writes: a cursor after the last line, and a word
     *  while nothing has arrived. */
    active?: boolean;
    /** Copy on the panel's corner. Off where the surface has its own copy. */
    copyable?: boolean;
    /** The scrolling element, for a caller that follows new output. */
    scroller?: HTMLElement | null;
    /** Long lines wrap. Off for a command someone must read verbatim: it
     *  scrolls sideways rather than re-flowing. */
    wrap?: boolean;
    /** Read each line for an error or a warning and colour it. Off for a
     *  command, which is not a result. */
    tones?: boolean;
    /** No ring or radius of its own: the caller's box frames it. */
    frameless?: boolean;
    class?: string;
  }
  let {
    output,
    label,
    truncated = false,
    active = false,
    copyable = true,
    scroller = $bindable(null),
    wrap = true,
    tones = true,
    frameless = false,
    class: className,
  }: Props = $props();

  const lines = $derived(output ? terminalLines(output) : []);

  async function copy(): Promise<void> {
    await copyText(plainTerminalText(output));
    toasts.success("Output copied");
  }
</script>

{#snippet cursor()}
  <span class="ml-px inline-block h-[1.1em] w-[0.55em] translate-y-[0.2em] bg-[var(--solus-terminal-fg)] opacity-70" aria-hidden="true"></span>
{/snippet}

<div class={cn("group/terminal relative min-h-0", className)} data-testid="terminal-output">
  <div
    bind:this={scroller}
    class={cn(
      "max-h-[inherit] overflow-auto bg-[var(--solus-terminal-bg)] px-[0.8125rem] py-3 font-mono text-tool-step leading-[1.6] text-[var(--solus-terminal-fg)] selection:bg-[color:color-mix(in_oklch,var(--solus-terminal-fg)_20%,transparent)]",
      !frameless && "rounded-lg shadow-[shadow:0_0_0_0.03125rem_var(--solus-terminal-border)]",
    )}
    role="log"
    aria-label={label}
  >
    {#if truncated}<p class="m-0 text-[var(--solus-terminal-dim)]">… earlier output is not kept</p>{/if}
    {#if lines.length === 0}
      <p class="m-0 text-[var(--solus-terminal-dim)]">{active ? "Waiting for output" : "No output."}{#if active}{@render cursor()}{/if}</p>
    {:else}
      <pre class={wrap ? "m-0 break-words whitespace-pre-wrap" : "m-0 whitespace-pre"}>{#each lines as line, index (index)}<span
            class:text-[var(--solus-terminal-error)]={tones && line.tone === "error"}
            class:text-[var(--solus-terminal-warning)]={tones && line.tone === "warning"}
          >{#each line.spans as span, spanIndex (spanIndex)}<span
                class:font-semibold={span.bold}
                class:opacity-70={span.dim}
                style={span.color ? `color: var(--solus-terminal-${span.bright ? "bright-" : ""}${span.color})` : undefined}
              >{span.text}</span>{/each}</span>{#if index < lines.length - 1}{"\n"}{/if}{/each}{#if active}{@render cursor()}{/if}</pre>
    {/if}
  </div>
  {#if copyable && output}
    <!-- On the panel's corner, shown when the pointer is over it or it has
         focus; a touch screen sees it always. -->
    <Button
      size="icon-xs"
      variant="ghost"
      class="absolute top-1.5 right-1.5 text-[var(--solus-terminal-dim)] opacity-0 transition-opacity group-hover/terminal:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:bg-[color:color-mix(in_oklch,var(--solus-terminal-fg)_10%,transparent)] hover:text-[var(--solus-terminal-fg)]"
      aria-label="Copy the output"
      title="Copy the output"
      onclick={copy}
    >
      <CopyIcon />
    </Button>
  {/if}
</div>
