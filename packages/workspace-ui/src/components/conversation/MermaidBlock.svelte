<script lang="ts">
  import {
    Check as CheckIcon,
    Code as CodeIcon,
    Copy as CopyIcon,
    Play as PlayIcon,
  } from "@lucide/svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import SandboxFrame from "../artifact/SandboxFrame.svelte";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import { getHtmlBlockOrigin } from "./lib/html-block-origin";
  import { nearViewport } from "../../lib/near-viewport";
  import { loadDiagramRenderer, mermaidDiagram, type Pele } from "./lib/mermaid-block";

  /**
   * A settled ```mermaid fence in a reply, drawn as the diagram it describes.
   *
   * The source is never far: it is what shows until the renderer loads, what
   * Source flips back to, and what stays on screen — with the parser's
   * complaint under it — when the text does not draw. A blank card is never
   * an outcome.
   */
  interface Props {
    text: string;
  }

  let { text }: Props = $props();

  // Set in a conversation: the same signal an HTML block uses to take the full
  // transcript column while the prose around it stays narrow.
  const origin = getHtmlBlockOrigin();

  // Pele with this diagram's type loaded, and the text it loaded for; null
  // until then, or when it did not load. The text travels with Pele, so a
  // diagram of a new type draws only once that type's chunk is in.
  let renderer = $state.raw<{ pele: Pele; source: string } | null>(null);
  let loadFailed = $state(false);
  // Set by the mounted diagram: the parser's message, or null once it draws.
  let renderError = $state<string | null>(null);
  // The reader's choice, not remembered: it does not outlive the message on screen.
  let showSource = $state(false);
  let copied = $state(false);
  // Every tab stays mounted, so a transcript full of diagrams in tabs the
  // reader is not looking at would otherwise load ahead of the one they are.
  // Loading starts when the block nears the viewport, and never un-starts.
  let isNearViewport = $state(false);

  // Async, so an effect rather than a derived.
  $effect(() => {
    if (!isNearViewport) return;
    const source = text;
    let active = true;
    void loadDiagramRenderer(source).then((pele) => {
      if (!active) return;
      renderer = pele ? { pele, source } : null;
      loadFailed = !pele;
    });
    return () => { active = false; };
  });

  // The diagram stays mounted while its text does not parse, hidden, so the
  // source and the message show in its place.
  const isDiagramShown = $derived(!!renderer && !showSource && renderError === null);
  const errorMessage = $derived(renderError ?? (loadFailed ? "The diagram renderer did not load." : null));

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

{#if renderer && !showSource}
  <!-- A plain container-coloured canvas. It takes the full transcript column,
       like an HTML block; the diagram sits at its own size inside it. -->
  <div
    class="my-2 {origin ? 'w-full' : ''}"
    hidden={!isDiagramShown}
    data-testid="mermaid-block"
    data-conversation-preview={origin ? true : undefined}
  >
    <SandboxFrame>
      <div
        class="flex w-full justify-center overflow-auto rounded-2xl border border-(--solus-tool-border) bg-(--solus-container-bg) px-6 py-7"
        use:mermaidDiagram={{
          pele: renderer.pele,
          source: renderer.source,
          onRender: () => (renderError = null),
          onError: (message) => (renderError = message),
        }}
      ></div>
      {#snippet actions()}
        {@render action("Show source", "mermaid-block-source", toggleSource, CodeIcon)}
        {@render action(copied ? "Copied" : "Copy source", "mermaid-block-copy", copySource, copied ? CheckIcon : CopyIcon)}
      {/snippet}
    </SandboxFrame>
  </div>
{/if}
{#if !isDiagramShown}
  <div class="my-2" data-testid="mermaid-block-source" use:nearViewport={() => (isNearViewport = true)}>
    <CodeBlock {text} lang="mermaid">
      {#snippet actions()}
        {#if renderer && renderError === null}
          <button type="button" class="solus-code-action" data-testid="mermaid-block-diagram" onclick={toggleSource}>
            <PlayIcon size={11} />
            Diagram
          </button>
        {/if}
      {/snippet}
    </CodeBlock>
    {#if errorMessage}
      <p class="mt-1.5 text-xs leading-snug text-destructive" role="alert" data-testid="mermaid-block-error">{errorMessage}</p>
    {/if}
  </div>
{/if}
