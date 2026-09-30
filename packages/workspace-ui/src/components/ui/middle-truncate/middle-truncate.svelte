<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements'
  import { cn } from '../../../lib/utils'
  import { splitForMiddleTruncate } from './middle-truncate'

  /**
   * Truncates in the middle, the way Finder does, for strings that carry
   * meaning at both ends: branch names, paths, worktree names. A tail cut of
   * `fix/cache-main-20260918-180825` loses the date that tells two branches
   * apart; a path loses its file name.
   *
   * CSS has no middle ellipsis, so the string is split into a head that
   * truncates and a tail that does not. No measuring and no observers, so it
   * costs the same as `truncate` in a long list. Both halves are real text:
   * selection and copy give the whole string, and a screen reader reads it
   * through.
   */
  interface Props extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
    value: string
    /** Characters kept at the end. Defaults to the last path segment, capped, or 10. */
    tail?: number
    /** The full value on hover. Off where a tooltip already carries it. */
    showTitle?: boolean
  }

  let { value, tail, showTitle = true, class: extraClass = '', ...rest }: Props = $props()

  const split = $derived(splitForMiddleTruncate(value, tail))
</script>

<span
  title={showTitle ? value : undefined}
  class={cn('inline-flex min-w-0 max-w-full overflow-hidden whitespace-nowrap', extraClass)}
  {...rest}
>
  {#if split}
    <span class="min-w-0 truncate">{split.head}</span><span class="shrink-0">{split.tail}</span>
  {:else}
    <span class="min-w-0 truncate">{value}</span>
  {/if}
</span>
