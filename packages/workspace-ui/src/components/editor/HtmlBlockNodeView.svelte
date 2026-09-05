<script lang="ts">
  import { untrack } from "svelte";
  import { Code as CodeIcon, Eye as EyeIcon, Pencil as PencilIcon } from "@lucide/svelte";
  import SandboxFrame from "../artifact/SandboxFrame.svelte";

  /**
   * A live ```html fence inside a document or a plan.
   *
   * Two ways out, because the block is content the reader may need to change:
   * Edit reveals the markup in place and commits it back to the node, and
   * "Show as code" turns the whole block back into a ```html source fence —
   * the reverse of the Render action on an html code block.
   */
  interface Props {
    html: string;
    /** See `HtmlBlockExtensionOptions`: a node view is mounted outside the
     *  component tree, so the theme arrives as a getter. */
    isDark: () => boolean;
    onCommit: (html: string) => void;
    onShowAsCode: () => void;
  }

  let { html, isDark, onCommit, onShowAsCode }: Props = $props();

  const dark = $derived(isDark());

  // The markup the frame runs. Owned here so an outside edit (undo, a
  // collaborator, the source editor) can replace it through `setHtml`.
  let current = $state(untrack(() => html));
  let editing = $state(false);
  let draft = $state("");

  export function setHtml(next: string): void {
    current = next;
    if (!editing) draft = next;
  }

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

<div class="html-block-node my-5 overflow-hidden rounded-xl border border-(--solus-tool-border) bg-(--solus-container-bg)">
  <div class="flex items-center gap-2 border-b border-(--solus-tool-border) px-3 py-2" contenteditable="false">
    <span class="min-w-0 flex-1 text-xs font-medium uppercase tracking-wide text-(--solus-text-tertiary)">HTML</span>
    <button
      type="button"
      class="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-(--solus-text-secondary) transition-colors duration-(--duration-quick) ease-(--ease-premium) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
      title={editing ? "Back to the render" : "Edit the markup"}
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
      aria-label="HTML source"
    ></textarea>
  {:else}
    <!-- The frame re-renders on commit, never per keystroke. -->
    <div class="max-h-[70cqh] overflow-auto p-3" contenteditable="false">
      <SandboxFrame html={current} isDark={dark} tooltips={false} />
    </div>
  {/if}
</div>
