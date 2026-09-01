<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { untrack } from "svelte";
  import { fly } from "svelte/transition";
  import {
    TextBIcon,
    TextItalicIcon,
    CodeIcon,
    LinkSimpleIcon,
    SparkleIcon,
  } from "phosphor-svelte";
  import { Button } from "../ui/button";
  import { portal } from "../portal";
  import { selectionRect, clampedCentre } from "./lib/selection-bubble";

  interface Props {
    editor: Editor | null;
    /** Opens the link popover on the current selection (owned by the editor). */
    onLink: () => void;
    /** Provided only when the surface has comments *and* the current selection
     *  is long enough to anchor one — absent hides the Comment action. */
    onComment?: () => void;
    /** Provided only when the surface is backed by a work with a chat. */
    onAskSolus?: () => void;
  }

  let { editor, onLink, onComment, onAskSolus }: Props = $props();

  // Roughly the widest the bubble gets — only used to keep it on screen, so an
  // approximation is fine and avoids measuring before the first paint.
  const BUBBLE_WIDTH = 320;

  let rect = $state<DOMRect | null>(null);
  let focused = $state(false);
  // Bumped on every transaction so the B/I/code pressed states re-read.
  let stateVersion = $state(0);

  // The bubble is chrome for a live selection: it appears with one and leaves
  // when the editor gives up focus. That single rule also gets the popovers
  // right for free — the link popover, the comment form and the find bar all
  // take focus, so the bubble steps aside for each of them without needing to
  // know any of them exist.
  const open = $derived(!!editor && focused && !!rect);

  $effect(() => {
    const ed = editor;
    if (!ed) return;

    let pending = false;
    const sync = () => {
      pending = false;
      rect = selectionRect(ed);
      stateVersion++;
    };
    // Coalesce to one layout read per frame: a drag-select fires selectionUpdate
    // per mouse move, and each getBoundingClientRect is a forced reflow.
    const schedule = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(sync);
    };
    const onFocus = () => {
      focused = true;
      schedule();
    };
    const onBlur = () => {
      focused = false;
    };

    ed.on("selectionUpdate", schedule);
    ed.on("transaction", schedule);
    ed.on("focus", onFocus);
    ed.on("blur", onBlur);
    focused = ed.isFocused;
    // sync increments stateVersion; keep that read out of this effect's
    // dependencies or the initial sync schedules the effect again forever.
    untrack(sync);

    return () => {
      ed.off("selectionUpdate", schedule);
      ed.off("transaction", schedule);
      ed.off("focus", onFocus);
      ed.off("blur", onBlur);
    };
  });

  function isActive(name: string): boolean {
    stateVersion;
    return editor?.isActive(name) ?? false;
  }

  function run(action: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) {
    if (!editor) return;
    action(editor.chain().focus()).run();
  }

  // Every control keeps the caret where it is: without this the mousedown
  // blurs the editor, the selection collapses, and the command applies to
  // nothing.
  function keepSelection(e: MouseEvent) {
    e.preventDefault();
  }
</script>

<!-- `data-selection-bubble` is a behavioural hook, not a test one: a surface
     with an outside-click dismisser has to count the bubble as inside, because
     it is where the actions that act on the selection live. -->
{#if open && rect}
  <div
    use:portal={document.body}
    data-solus-ui
    data-selection-bubble
    data-testid="selection-bubble"
    class="doc-bubble fixed z-[10001]"
    style="left:{clampedCentre(rect, BUBBLE_WIDTH)}px;top:{rect.top}px"
    transition:fly={{ y: 4, duration: 120, opacity: 0 }}
  >
    <Button
      variant="ghost"
      size="icon-xs"
      class="text-(--solus-text-primary)"
      aria-pressed={isActive("bold")}
      data-on={isActive("bold") ? "" : undefined}
      onmousedown={keepSelection}
      onclick={() => run((c) => c.toggleBold())}
      title="Bold (⌘B)"
      aria-label="Bold"
    >
      <TextBIcon size={13} weight="bold" />
    </Button>
    <Button
      variant="ghost"
      size="icon-xs"
      class="text-(--solus-text-primary)"
      aria-pressed={isActive("italic")}
      data-on={isActive("italic") ? "" : undefined}
      onmousedown={keepSelection}
      onclick={() => run((c) => c.toggleItalic())}
      title="Italic (⌘I)"
      aria-label="Italic"
    >
      <TextItalicIcon size={13} />
    </Button>
    <Button
      variant="ghost"
      size="icon-xs"
      class="text-(--solus-text-primary)"
      aria-pressed={isActive("code")}
      data-on={isActive("code") ? "" : undefined}
      onmousedown={keepSelection}
      onclick={() => run((c) => c.toggleCode())}
      title="Inline code"
      aria-label="Inline code"
    >
      <CodeIcon size={13} />
    </Button>
    <Button
      variant="ghost"
      size="icon-xs"
      class="text-(--solus-text-primary)"
      aria-pressed={isActive("link")}
      data-on={isActive("link") ? "" : undefined}
      onmousedown={keepSelection}
      onclick={onLink}
      title="Link (⌥⇧K)"
      aria-label="Link"
    >
      <LinkSimpleIcon size={13} />
    </Button>

    {#if onComment || onAskSolus}
      <span class="doc-bubble__sep" aria-hidden="true"></span>
    {/if}

    <!-- The two actions unique to this app. Amber is annotation, terracotta is
         Solus — the same colour language as the marks they produce. -->
    {#if onComment}
      <Button
        variant="ghost"
        size="xs"
        class="doc-bubble__comment text-(--solus-text-primary)"
        onmousedown={keepSelection}
        onclick={onComment}
        data-testid="bubble-comment"
        title="Comment on selection"
      >
        <span class="doc-bubble__swatch" aria-hidden="true"></span>
        Comment
      </Button>
    {/if}
    {#if onAskSolus}
      <Button
        variant="ghost"
        size="xs"
        class="text-(--solus-accent) hover:bg-(--solus-accent-light) hover:text-(--solus-accent)"
        onmousedown={keepSelection}
        onclick={onAskSolus}
        data-testid="bubble-ask-solus"
        title="Ask Solus about this selection"
      >
        <SparkleIcon size={12} weight="fill" />
        Ask Solus
      </Button>
    {/if}
  </div>
{/if}

<style>
  .doc-bubble {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    padding: 0.3125rem;
    border-radius: 1rem;
    border: 0.0625rem solid var(--solus-popover-border);
    background: var(--solus-popover-bg);
    box-shadow: var(--solus-popover-shadow);
    backdrop-filter: blur(1.25rem) saturate(1.1);
    -webkit-backdrop-filter: blur(1.25rem) saturate(1.1);
    /* Centred on the selection and lifted clear of its top edge. */
    transform: translate(-50%, calc(-100% - 0.375rem));
    white-space: nowrap;
  }
  .doc-bubble__sep {
    width: 0.0625rem;
    height: 1rem;
    margin: 0 0.25rem;
    background: var(--solus-container-border);
  }
  /* Pressed formatting state. `aria-pressed` alone can't be styled through the
     Button primitive's variant classes, so the mirror attribute carries it. */
  .doc-bubble :global([data-on]) {
    background: var(--solus-accent-light);
    color: var(--solus-accent);
  }
  /* Comment is pre-tinted amber — the action already wears the colour of the
     mark it will leave behind, so the button is the legend for the highlight. */
  .doc-bubble :global(.doc-bubble__comment) {
    background: color-mix(in srgb, var(--solus-art-2) 30%, transparent);
  }
  .doc-bubble :global(.doc-bubble__comment:hover) {
    background: color-mix(in srgb, var(--solus-art-2) 42%, transparent);
  }
  .doc-bubble__swatch {
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: 0.125rem;
    background: color-mix(in srgb, var(--solus-art-2) 75%, transparent);
  }
</style>
