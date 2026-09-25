<script lang="ts">
  import GithubMarkdown from './GithubMarkdown.svelte'
  import { Button } from '../ui/button'
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

  function toggle() {
    // Collapsing a long body would leave the reader far below the card.
    if (expanded) frame?.scrollIntoView({ block: 'nearest' })
    expanded = !expanded
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
{#if overflowing}
  <Button
    type="button"
    variant="ghost"
    size="xs"
    class="mt-2 -ml-2 cursor-pointer text-muted-foreground"
    aria-expanded={expanded}
    aria-controls={bodyId}
    onclick={toggle}
  >
    {expanded ? 'Show less' : 'Show full comment'}
  </Button>
{/if}
