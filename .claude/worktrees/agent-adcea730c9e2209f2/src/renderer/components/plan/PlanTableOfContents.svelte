<script lang="ts">
  interface Heading {
    level: number
    text: string
    pos: number
  }

  interface Props {
    headings: Heading[]
    activePos?: number | null
    onScrollTo: (pos: number) => void
  }

  let { headings, activePos = null, onScrollTo }: Props = $props()
</script>

{#if headings.length >= 2}
  <div class="plan-toc">
    <div class="plan-toc__label">
      On this page
    </div>
    {#each headings as h (h.pos)}
      <button
        type="button"
        onclick={() => onScrollTo(h.pos)}
        class="plan-toc__item"
        class:plan-toc__item--active={activePos === h.pos}
        style="padding-left: {(h.level - 2) * 10 + 10}px"
        title={h.text}
      >
        <span class="plan-toc__rail" aria-hidden="true"></span>
        <span class="plan-toc__text">{h.text}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .plan-toc {
    position: sticky;
    top: 0;
  }
  .plan-toc__label {
    font-size: 0.6563rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--solus-text-tertiary);
    margin-bottom: 0.5rem;
    padding-left: 0.625rem;
  }
  .plan-toc__item {
    position: relative;
    display: block;
    width: 100%;
    text-align: left;
    font-size: 0.6875rem;
    line-height: 1.5;
    padding: 0.3125rem 0.625rem;
    margin: 0.0625rem 0;
    border-radius: 0.375rem;
    color: var(--solus-text-tertiary);
    background: transparent;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: background var(--duration-quick) var(--ease-premium),
                color var(--duration-quick) var(--ease-premium);
  }
  .plan-toc__rail {
    position: absolute;
    left: 0;
    top: 0.375rem;
    bottom: 0.375rem;
    width: 0.125rem;
    border-radius: 0 0.125rem 0.125rem 0;
    background: var(--solus-accent);
    opacity: 0;
    transform: translateX(-0.125rem);
    transition: opacity var(--duration-base) var(--ease-premium),
                transform var(--duration-base) var(--ease-premium);
  }
  .plan-toc__item:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .plan-toc__item--active {
    background: var(--solus-accent-light);
    color: var(--solus-accent);
    font-weight: 500;
  }
  .plan-toc__item--active .plan-toc__rail {
    opacity: 1;
    transform: translateX(0);
  }
  .plan-toc__item:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
  }
  .plan-toc__text {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  @media (prefers-reduced-motion: reduce) {
    .plan-toc__item,
    .plan-toc__rail {
      transition: none !important;
    }
  }
</style>
