<script lang="ts">
  import type { Snippet } from 'svelte'
  import { Check as CheckIcon } from '@lucide/svelte'
  import TranscriptCard from './TranscriptCard.svelte'

  /**
   * The attention shell for a moment the turn stops until the user acts
   * (docs/transcript-cards.md): a rate limit or a connection. Permission and
   * question cards keep their own layout in `InterruptCard`. When the user has
   * acted, the card collapses to a quiet header-only line with a check glyph
   * and the outcome as its type word.
   */
  interface Props {
    /** Short human summary — verb first, no payload pasted in. */
    title: string
    /** Lowercase type word. Once resolved, the one-line outcome. */
    type: string
    /** Optional path, in mono. */
    target?: string
    /** The user acted: quiet, header only, check glyph. */
    resolved?: boolean
    testId: string
    icon: Snippet
    /** Counts and time only. Hidden once resolved. */
    rail?: Snippet
    /** At most one primary and one ghost button, plus icons. Also shows when
     *  resolved, so the caller decides the resolved line's Done. */
    actions?: Snippet
    /** The body, indented to the title. Hidden once resolved. */
    children?: Snippet
  }

  let {
    title,
    type,
    target,
    resolved = false,
    testId,
    icon,
    rail,
    actions,
    children,
  }: Props = $props()
</script>

<TranscriptCard
  {title}
  {type}
  {target}
  variant={resolved ? 'quiet' : 'attention'}
  glyphClass={resolved ? 'is-done' : ''}
  data-testid={testId}
  rail={resolved ? undefined : rail}
  {actions}
  body={resolved || !children ? undefined : cardBody}
>
  {#snippet glyph()}
    {#if resolved}<CheckIcon />{:else}{@render icon()}{/if}
  {/snippet}
</TranscriptCard>

{#snippet cardBody()}
  <div class="flex flex-col gap-2.5 pointer-fine:[.is-laptop-display_&]:gap-2">
    {@render children?.()}
  </div>
{/snippet}
