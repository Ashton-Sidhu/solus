<script lang="ts">
  import {
    Check as CheckIcon,
    Code as CodeIcon,
    Copy as CopyIcon,
    Play as PlayIcon,
  } from "@lucide/svelte";
  import { getSettingsContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import SandboxFrame from "../artifact/SandboxFrame.svelte";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import { getHtmlBlockOrigin } from "./lib/html-block-origin";
  import { nearViewport } from "./lib/near-viewport";
  import { renderMermaid, type MermaidResult } from "./lib/mermaid-block";

  /**
   * A settled ```mermaid fence in a reply, drawn as the diagram it describes.
   *
   * The source is never far: it is what shows until the render lands, what
   * Source flips back to, and what stays on screen — with the parser's
   * complaint under it — when the text does not draw. A blank card is never
   * an outcome.
   */
  interface Props {
    text: string;
  }

  let { text }: Props = $props();

  const settings = getSettingsContext();
  // Set in a conversation: the same signal an HTML block uses to take the full
  // transcript column while the prose around it stays narrow.
  const origin = getHtmlBlockOrigin();

  let result = $state<MermaidResult | null>(null);
  // The reader's choice, not remembered: it does not outlive the message on screen.
  let showSource = $state(false);
  let copied = $state(false);
  // Every tab stays mounted, so a transcript full of diagrams in tabs the
  // reader is not looking at would otherwise queue ahead of the one they are.
  // Rendering starts when the block nears the viewport, and never un-starts.
  let isNearViewport = $state(false);

  // Async and theme-bound, so an effect rather than a derived: the SVG bakes
  // its palette in, and a theme flip is a new render (served from cache when
  // the reader has been there before).
  $effect(() => {
    if (!isNearViewport) return;
    const dark = settings.isDark;
    const source = text;
    let active = true;
    void renderMermaid(source, dark).then((next) => {
      if (active) result = next;
    });
    return () => { active = false; };
  });

  const diagram = $derived(result?.svg && !showSource ? result.svg : null);

  async function copySource() {
    try {
      await navigator.clipboard.writeText(text.replace(/\n$/, ""));
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {}
    requestInputFocus();
  }

  function toggleSource() {
    showSource = !showSource;
    requestInputFocus();
  }
</script>

{#snippet action(label: string, testId: string, onclick: () => void, icon: typeof CodeIcon)}
  {@const Icon = icon}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
        <button
          {...tooltipProps}
          type="button"
          class="artifact-action"
          data-testid={testId}
          aria-label={label}
          {onclick}
        >
          <Icon size={14} />
        </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content value={label} />
  </TooltipUI.Root>
{/snippet}

{#if diagram}
  <!-- A plain container-coloured canvas. It takes the full transcript column,
       like an HTML block; the diagram sits at its own size inside it. -->
  <div
    class="my-2 {origin ? 'w-full' : ''}"
    data-testid="mermaid-block"
    data-conversation-preview={origin ? true : undefined}
  >
    <SandboxFrame>
      <div class="flex w-full justify-center overflow-auto rounded-2xl border border-(--solus-tool-border) bg-(--solus-container-bg) px-6 py-7 [&_svg]:h-auto [&_svg]:max-w-full">{@html diagram}</div>
      {#snippet actions()}
        {@render action("Show source", "mermaid-block-source", toggleSource, CodeIcon)}
        {@render action(copied ? "Copied" : "Copy source", "mermaid-block-copy", copySource, copied ? CheckIcon : CopyIcon)}
      {/snippet}
    </SandboxFrame>
  </div>
{:else}
  <div class="my-2" data-testid="mermaid-block-source" use:nearViewport={() => (isNearViewport = true)}>
    <CodeBlock {text} lang="mermaid">
      {#snippet actions()}
        {#if result?.svg}
          <button type="button" class="solus-code-action" data-testid="mermaid-block-diagram" onclick={toggleSource}>
            <PlayIcon size={11} />
            Diagram
          </button>
        {/if}
      {/snippet}
    </CodeBlock>
    {#if result?.error}
      <p class="mt-1.5 text-xs leading-snug text-destructive" role="alert" data-testid="mermaid-block-error">{result.error}</p>
    {/if}
  </div>
{/if}

