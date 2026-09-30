<script lang="ts">
  import { tick } from 'svelte'
  import GithubMarkdown from './GithubMarkdown.svelte'
  import { ChevronDown as ChevronDownIcon } from '@lucide/svelte'
  import type { MarkdownPolicy } from './lib/github-markdown'

  // A comment body in a timeline card. A long report (a CI bot's screenful, a
  // pasted log) shows a 240px preview with a fade and a "Show full comment"
  // control; the complete markdown stays in the DOM, so find-in-page and
  // keyboard focus still reach it. Focus moving inside opens the preview.
  // The fade is painted in `--background`, the fill of every comment card.
  let { source, policy = 'remote' }: { source: string; policy?: MarkdownPolicy } = $props()

  const PREVIEW_HEIGHT = 240

  let expanded = $state(false)
  let contentHeight = $state(0)
  let frame = $state<HTMLDivElement>()
  const overflowing = $derived(contentHeight > PREVIEW_HEIGHT)
  const bodyId = $props.id()

  async function toggle() {
    expanded = !expanded
    if (expanded) return
    // Collapsing a long body would leave the reader far below the card. Scroll
    // once the preview has its short height, so "nearest" measures the frame
    // the reader will see; focus stays on this control, now under the preview.
    await tick()
    frame?.scrollIntoView({ block: 'nearest' })
  }
</script>

<div
  bind:this={frame}
  id={bodyId}
  class="relative {overflowing && !expanded ? 'max-h-[240px] overflow-hidden' : ''}"
  onfocusin={() => (expanded = true)}
>
  <div bind:clientHeight={contentHeight} class="github-markdown prose-cloud prose-pr prose-pr-activity">
    <GithubMarkdown {source} {policy} />
  </div>
  {#if overflowing && !expanded}
    <div
      class="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-background to-transparent"
      aria-hidden="true"
    ></div>
  {/if}
</div>
<!-- A quiet text action, not a button with a fill: it belongs to the comment
     it folds. The ghost Button painted a resting fill once expanded — its
     `aria-expanded` style is a menu trigger's "open" state. -->
{#if overflowing}
  <button
    type="button"
    class="mt-1.5 -ml-1 inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1 text-workspace-chrome font-normal text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-10"
    aria-expanded={expanded}
    aria-controls={bodyId}
    onclick={toggle}
  >
    {expanded ? 'Show less' : 'Show full comment'}
    <ChevronDownIcon
      size={13}
      class="shrink-0 opacity-70 transition-transform duration-150 motion-reduce:transition-none {expanded ? 'rotate-180' : ''}"
      aria-hidden="true"
    />
  </button>
{/if}
