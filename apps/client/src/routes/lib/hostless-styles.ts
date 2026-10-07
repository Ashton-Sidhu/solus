/**
 * The card and field of the hostless home. The draft's connect page
 * (`session-draft/ConnectHostPage.svelte`) draws the same card, so the two
 * pages read as one.
 */
export const cardClass =
  'group/card flex w-full items-center gap-3.5 overflow-hidden rounded-2xl bg-(--solus-input-pill-bg) shadow-[shadow:0_0_0_0.03125rem_var(--solus-container-border),0_12px_28px_-20px_rgb(0_0_0/35%)] dark:shadow-[shadow:0_0_0_0.03125rem_var(--solus-container-border)] transition-[box-shadow,scale] duration-[var(--duration-quick)] ease-(--ease-premium) focus-within:shadow-[shadow:0_0_0_0.0625rem_color-mix(in_oklch,var(--solus-accent)_34%,transparent),0_0_0_0.25rem_color-mix(in_oklch,var(--solus-accent)_9%,transparent)] focus-visible:outline-none'

export const fieldClass =
  'w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2 text-workspace-chrome text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]'
