<script lang="ts">
  // A quiet button, the same weight as Review and the number pill beside it.
  // Once the labels drop, the glyph sits in a square the size of the overflow.
  import { GitPullRequest as GitPullRequestIcon, LoaderCircle as CircleNotchIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  let { preparingComposer, disabled, onclick }: {
    preparingComposer: boolean;
    disabled: boolean;
    onclick: () => void;
  } = $props();
</script>

  <Button
    type="button"
    variant="ghost"
    size="xs"
    class="h-6.5 shrink-0 gap-1.5 rounded-full bg-background px-2.5 text-workspace-chrome font-normal text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:bg-[var(--wash-1)] pointer-coarse:h-10 pointer-coarse:px-3.5 @max-[40rem]/band:px-[5.5px] @max-[40rem]/band:pointer-coarse:px-[12.5px]"
    {onclick}
    disabled={preparingComposer || disabled}
    aria-label="Check out this pull request"
    title={preparingComposer
      ? "Preparing checkout…"
      : "Check out this pull request in its own worktree and open a session composer on it"}
  >
    {#if preparingComposer}
      <CircleNotchIcon
        class="size-3 animate-spin [animation-duration:0.9s]"
        aria-hidden="true"
      />
    {:else}
      <GitPullRequestIcon class="size-[15px]" strokeWidth={1.5} aria-hidden="true" />
    {/if}
    <span class="@max-[40rem]/band:hidden">
      {preparingComposer ? "Preparing…" : "Check out"}
    </span>
  </Button>
