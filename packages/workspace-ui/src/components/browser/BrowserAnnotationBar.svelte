<script lang="ts">
  import {
    MousePointer2,
    MousePointerClick,
    PenLine,
    Square,
  } from "@lucide/svelte";
  import type {
    BrowserAnnotationTool,
    BrowserPage,
  } from "@solus/contracts/browser-types";

  /**
   * The tools, and nothing else.
   *
   * A pill floating over the page, bottom-centred: the tools belong to the page,
   * not to the workspace. Which of two places it is mounted in is the stage's
   * business — over a native `<webview>` it goes through the app-root layer,
   * over a streamed canvas the stage floats it directly.
   *
   * Fixed height, and no list. The completed annotation attaches to the active
   * draft composer. The browser keeps its full canvas and does not open a second
   * comment surface beside the page.
   */

  interface Props {
    page: BrowserPage;
    /** How many marks are already on the draft. */
    marked: number;
    onTool: (tool: BrowserAnnotationTool | null) => void;
    onClear: () => void;
    onClose: () => void;
  }

  let { page, marked, onTool, onClear, onClose }: Props = $props();

  // Select · pick · freehand · box. Box is a marquee: one drag collects
  // every visible element fully inside it as one grouped mark. Clear removes
  // the current set without leaving an erase tool armed over the page.
  const TOOLS: { id: BrowserAnnotationTool; label: string; hint: string }[] = [
    {
      id: "select",
      label: "Select",
      hint: "Use the page — clicks go through, marks stay up",
    },
    {
      id: "pick",
      label: "Pick element",
      hint: "Click an element — carries its selector and measured size",
    },
    { id: "draw", label: "Freehand", hint: "Circle or underline freehand" },
    {
      id: "region",
      label: "Select with box",
      hint: "Drag a box to select every element fully inside it",
    },
  ];
</script>

<!-- A pill, the way every drawing tool puts its tools: close to the marks, off
     the chrome, and one of the two ways out of annotate mode. -->
<div
  class="text-workspace-chrome flex h-10 max-w-full shrink-0 items-center gap-[3px] overflow-hidden rounded-full bg-[var(--popover)] p-1 shadow-[shadow:0_0_0_0.5px_var(--hairline-strongest),0_0.125rem_0.25rem_-0.125rem_rgba(0,0,0,0.14),0_1.25rem_2.5rem_-1rem_rgba(0,0,0,0.36)] [.is-laptop-display_&]:h-9"
>
  {#each TOOLS as tool (tool.id)}
    <button
      type="button"
      class="flex size-7.5 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary) [.is-laptop-display_&]:size-6.5 {page.annotationTool ===
      tool.id
        ? 'bg-[color-mix(in_oklch,var(--primary)_14%,transparent)] text-[var(--primary)] hover:bg-[color-mix(in_oklch,var(--primary)_14%,transparent)] hover:text-[var(--primary)]'
        : ''}"
      aria-pressed={page.annotationTool === tool.id}
      aria-label={tool.label}
      title={tool.hint}
      onclick={() => onTool(page.annotationTool === tool.id ? null : tool.id)}
    >
      {#if tool.id === "select"}<MousePointer2 class="size-3.5" />
      {:else if tool.id === "pick"}<MousePointerClick class="size-3.5" />
      {:else if tool.id === "draw"}<PenLine class="size-3.5" />
      {:else}<Square class="size-3.5" />{/if}
    </button>
  {/each}

  <div class="mx-1 h-4 w-px shrink-0 bg-[var(--hairline-strong)]"></div>

  <span
    class="shrink-0 px-1 whitespace-nowrap text-(--solus-text-tertiary) tabular-nums"
  >
    {marked === 1 ? "1 mark" : `${marked} marks`}
  </span>

  {#if marked > 0}
    <button
      type="button"
      class="shrink-0 rounded-full px-2 py-1 text-(--solus-text-tertiary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary)"
      onclick={onClear}
    >
      Clear
    </button>
  {/if}
  <button
    type="button"
    class="shrink-0 rounded-full px-2.5 py-1 text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary)"
    aria-label="Close annotation tools"
    onclick={onClose}
  >
    Done
  </button>
</div>
