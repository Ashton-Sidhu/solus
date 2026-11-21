<script lang="ts">
  import { Square as StopIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";

  /**
   * The Stop of a row of the session's background work, on the row's rail:
   * every row of that work (`BackgroundWorkRow`, `BackgroundItemRow`) stops
   * the same way, in the same place, with the same touch target.
   */
  interface Props {
    /** What the button does, for a screen reader. */
    label: string;
    /** The tooltip; the label when not given. */
    title?: string;
    disabled: boolean;
    onclick: () => void;
    testid: string;
  }
  let { label, title = label, disabled, onclick, testid }: Props = $props();
</script>

<Button
  variant="ghost"
  size="xs"
  class="size-5 rounded-full p-0 text-[color:color-mix(in_oklch,var(--failure)_70%,var(--foreground))] shadow-[shadow:0_0_0_0.03125rem_color-mix(in_oklch,var(--failure)_45%,transparent)] hover:bg-[color:color-mix(in_oklch,var(--failure)_10%,transparent)] hover:text-(color:--failure) dark:hover:bg-[color:color-mix(in_oklch,var(--failure)_14%,transparent)] pointer-coarse:tap-area"
  {disabled}
  {onclick}
  aria-label={label}
  {title}
  data-testid={testid}
>
  <!-- The composer's own Stop: a filled square in a thin failure ring, so it
       reads as Stop at a glance rather than as a rail figure. -->
  <StopIcon class="size-2" fill="currentColor" strokeWidth={0} aria-hidden="true" />
</Button>
