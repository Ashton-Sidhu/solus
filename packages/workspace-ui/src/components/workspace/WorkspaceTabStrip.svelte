<script lang="ts">
  import type { WorkspaceTab, WorkspaceTabSpec } from "./lib/workspace-items";
  import type { PresencePerson } from "../presence/lib/presence-people";
  import PresenceStack from "../presence/PresenceStack.svelte";

  /**
   * The page's three groups as a strip: the reader's own works, then the works
   * and the sessions other people shared with them. Soft pills: the current
   * group sits on a quiet wash with a hairline edge, the others are plain text
   * that takes the wash under the pointer.
   *
   * A shared tab also shows who is in its records right now, so activity is
   * visible before the reader switches to it.
   */
  interface Props {
    tabs: WorkspaceTabSpec[];
    tab: WorkspaceTab;
    onSelect: (tab: WorkspaceTab) => void;
    /** Everyone present in the records a tab holds; empty for the reader's own tab. */
    presentIn: (tab: WorkspaceTab) => PresencePerson[];
  }
  let { tabs, tab, onSelect, presentIn }: Props = $props();
</script>

<div
  class="no-drag flex h-11 shrink-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:h-0"
  role="tablist"
  aria-label="Workspace groups"
>
  {#each tabs as spec (spec.id)}
    {@const isActive = spec.id === tab}
    {@const present = presentIn(spec.id)}
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      data-testid="workspace-tab"
      data-tab={spec.id}
      class="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 px-3 text-workspace-chrome transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-10 {isActive
        ? 'bg-[var(--wash-3)] font-medium text-foreground shadow-[inset_0_0_0_.5px_var(--hairline-strong)]'
        : 'bg-transparent font-normal text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground'}"
      onclick={() => onSelect(spec.id)}
    >
      {spec.label}
      <!-- Zero is not drawn: an empty group is worth knowing about once, by
           opening it, not on every glance at the strip. -->
      {#if spec.count}
        <span class="text-xs tabular-nums text-muted-foreground">{spec.count}</span>
      {/if}
      {#if present.length > 0}
        <PresenceStack people={present} size={14} max={2} class="ml-0.5" />
      {/if}
    </button>
  {/each}
</div>
