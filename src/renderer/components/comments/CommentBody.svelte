<script lang="ts">
  import { parseCommentText } from './lib/comment-text'

  interface Props {
    text: string
    /** Thread bodies clamp to four lines with a "more"; replies never do. */
    clamp?: boolean
  }

  let { text, clamp = false }: Props = $props()

  const blocks = $derived(parseCommentText(text))

  let expanded = $state(false)
  let bodyEl: HTMLDivElement | null = $state(null)
  let clamped = $state(false)

  // "more" appears only when the clamp is actually cutting something off, so a
  // three-line comment doesn't grow an affordance it has no use for.
  $effect(() => {
    blocks
    if (!clamp || !bodyEl || expanded) return
    clamped = bodyEl.scrollHeight - bodyEl.clientHeight > 1
  })
</script>

<div class="cb">
  <div class="cb__text" class:cb__text--clamp={clamp && !expanded} bind:this={bodyEl}>
    {#each blocks as block, i (i)}
      {#if block.kind === 'quote'}
        <!-- A one-line code quote: hairline and mono, never a fill. -->
        <div class="cb__quote">{block.text}</div>
      {:else}
        <p class="cb__para">
          {#each block.segments as segment, j (j)}
            {#if segment.kind === 'code'}
              <code class="cb__code">{segment.text}</code>
            {:else if segment.kind === 'bold'}
              <strong>{segment.text}</strong>
            {:else if segment.kind === 'italic'}
              <em>{segment.text}</em>
            {:else if segment.kind === 'mention'}
              <!-- A mention is a link: terracotta, no pill, no background. -->
              <span class="cb__mention">{segment.text}</span>
            {:else if segment.kind === 'link'}
              <a class="cb__link" href={segment.href} target="_blank" rel="noopener noreferrer"
                >{segment.text}</a
              >
            {:else}{segment.text}{/if}
          {/each}
        </p>
      {/if}
    {/each}
  </div>
  {#if clamp && clamped && !expanded}
    <button type="button" class="cb__more" onclick={() => (expanded = true)}>more</button>
  {/if}
</div>

<style>
  .cb {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }
  /* Inter, not the document's serif — a thread is chrome that happens to hold
     sentences, so it never borrows the face that means "this is the page". */
  .cb__text {
    /* Same size as the reply text below it and the author name above it — the
       body is the card's baseline register, never a step up from its own
       chrome. */
    font-size: 0.75rem;
    line-height: 1.6;
    color: color-mix(in srgb, var(--solus-text-primary) 90%, var(--solus-text-tertiary));
    word-break: break-word;
    user-select: text;
  }
  .cb__text--clamp {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    overflow: hidden;
  }
  .cb__para {
    margin: 0;
    white-space: pre-wrap;
  }
  .cb__para + .cb__para {
    margin-top: 0.35em;
  }
  /* The same warm wash as the document's inline code, one step smaller. */
  .cb__code {
    font-family: 'Geist Mono', var(--solus-code-font-family);
    font-size: 0.88em;
    background: var(--solus-art-raised);
    padding: 0.1em 0.32em;
    border-radius: 0.25rem;
  }
  .cb__quote {
    font-family: 'Geist Mono', var(--solus-code-font-family);
    font-size: 0.6875rem;
    line-height: 1.7;
    color: color-mix(in srgb, var(--solus-text-primary) 84%, var(--solus-text-tertiary));
    border-left: 0.0625rem solid color-mix(in srgb, var(--solus-art-border) 90%, transparent);
    padding-left: 0.5625rem;
    margin: 0.25rem 0;
    overflow-x: auto;
    white-space: pre;
  }
  .cb__mention {
    color: var(--solus-accent);
    font-weight: 500;
  }
  .cb__link {
    color: var(--solus-accent);
    text-decoration: none;
    border-bottom: 0.0625rem solid color-mix(in srgb, var(--solus-accent) 40%, transparent);
  }
  .cb__link:hover {
    border-bottom-color: var(--solus-accent);
  }
  .cb__more {
    align-self: flex-start;
    padding: 0;
    border: none;
    background: transparent;
    font-family: inherit;
    font-size: 0.6875rem;
    color: var(--solus-text-tertiary);
    cursor: pointer;
  }
  .cb__more:hover {
    color: var(--solus-text-primary);
  }

  /* Touch clients get one step up for legibility — the same step, not a jump. */
  @media (max-width: 767px) {
    .cb__text {
      font-size: 0.8125rem;
    }
  }
</style>
