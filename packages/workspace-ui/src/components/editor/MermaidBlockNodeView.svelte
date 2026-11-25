<script lang="ts">
  import { untrack } from "svelte";
  import { Code as CodeIcon, Eye as EyeIcon, Pencil as PencilIcon } from "@lucide/svelte";
  import { loadDiagramRenderer, mermaidDiagram, type Pele } from "../conversation/lib/mermaid-block";

  /**
   * A ```mermaid fence inside a document or a plan, drawn in place.
   *
   * Two ways out, because the block is content the reader may need to change:
   * Edit reveals the Mermaid text in place and commits it back to the node, and
   * "Show as code" turns the whole block back into a ```mermaid source fence —
   * the reverse of the Render action on a mermaid code block.
   */
  interface Props {
    source: string;
    onCommit: (source: string) => void;
    onShowAsCode: () => void;
  }

  let { source, onCommit, onShowAsCode }: Props = $props();

  // The text the diagram draws. Owned here so an outside edit (undo, a
  // collaborator, the source editor) can replace it through `setSource`.
  let current = $state(untrack(() => source));
  let editing = $state(false);
  let draft = $state("");
  // Pele with this diagram's type loaded, and the text it loaded for; null
  // until then, or when it did not load. The text travels with Pele, so a
  // diagram of a new type draws only once that type's chunk is in.
  let renderer = $state.raw<{ pele: Pele; source: string } | null>(null);
  let loadFailed = $state(false);
  // Set by the mounted diagram: the parser's message, or null once it draws.
  let renderError = $state<string | null>(null);

  export function setSource(next: string): void {
    current = next;
    if (!editing) draft = next;
  }

  // Async, so an effect. A new diagram type loads its own chunk.
  $effect(() => {
    const text = current;
    let active = true;
    void loadDiagramRenderer(text).then((pele) => {
      if (!active) return;
      renderer = pele ? { pele, source: text } : null;
      loadFailed = !pele;
    });
    return () => { active = false; };
  });

  const errorMessage = $derived(renderError ?? (loadFailed ? "The diagram renderer did not load." : null));

  function startEditing() {
    draft = current;
    editing = true;
  }

  function commit() {
    editing = false;
    if (draft === current) return;
    current = draft;
    onCommit(draft);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      editing = false;
      draft = current;
    }
  }
</script>

<div class="mermaid-block-node my-5 overflow-hidden rounded-xl border border-(--solus-tool-border) bg-(--solus-container-bg)">
  <div class="flex items-center gap-2 border-b border-(--solus-tool-border) px-3 py-2" contenteditable="false">
    <span class="min-w-0 flex-1 text-xs font-medium uppercase tracking-wide text-(--solus-text-tertiary)">Mermaid</span>
    <button
      type="button"
      class="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-(--solus-text-secondary) transition-colors duration-(--duration-quick) ease-(--ease-premium) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
      title={editing ? "Back to the diagram" : "Edit the diagram text"}
      onclick={() => (editing ? commit() : startEditing())}
    >
      {#if editing}
        <EyeIcon size={12} />
        Done
      {:else}
        <PencilIcon size={12} />
        Edit
      {/if}
    </button>
    <button
      type="button"
      class="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-(--solus-text-secondary) transition-colors duration-(--duration-quick) ease-(--ease-premium) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
      title="Keep this as a code block instead"
      onclick={onShowAsCode}
    >
      <CodeIcon size={12} />
      Show as code
    </button>
  </div>

  {#if editing}
    <!-- svelte-ignore a11y_autofocus -->
    <textarea
      class="block max-h-96 min-h-40 w-full resize-y border-0 bg-transparent p-3 font-mono text-xs leading-relaxed text-(--solus-text-primary) outline-none"
      bind:value={draft}
      onblur={commit}
      onkeydown={onKeydown}
      autofocus
      spellcheck="false"
      aria-label="Mermaid source"
    ></textarea>
  {:else}
    {#if renderer}
      <!-- The diagram re-renders on commit, never per keystroke. It stays
           mounted, hidden, while its text does not parse. -->
      <div
        class="flex max-h-[70cqh] justify-center overflow-auto bg-(--solus-container-bg) px-6 py-7"
        hidden={renderError !== null}
        contenteditable="false"
        use:mermaidDiagram={{
          pele: renderer.pele,
          source: renderer.source,
          onRender: () => (renderError = null),
          onError: (message) => (renderError = message),
        }}
      ></div>
    {/if}
    {#if !renderer || renderError !== null}
      <!-- Source while the renderer loads, and source with the parser's
           complaint when the text does not draw. A blank card is never an outcome. -->
      <pre class="m-0 overflow-auto p-3 font-mono text-xs leading-relaxed text-(--solus-text-primary)" contenteditable="false">{current}</pre>
      {#if errorMessage}
        <p class="m-0 border-t border-(--solus-tool-border) px-3 py-2 text-xs leading-snug text-destructive" role="alert">{errorMessage}</p>
      {/if}
    {/if}
  {/if}
</div>
