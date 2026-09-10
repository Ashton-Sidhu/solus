<script lang="ts">
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
    size="xs"
    class="ml-[5px] h-[26px] shrink-0 gap-1.5 px-2.5 text-workspace-chrome pointer-coarse:h-10 pointer-coarse:px-3.5 pointer-fine:[.is-laptop-display_&]:h-6 pointer-fine:[.is-laptop-display_&]:px-2 @max-[40rem]/band:px-2"
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
      <GitPullRequestIcon class="size-3" aria-hidden="true" />
    {/if}
    <span class="@max-[40rem]/band:hidden">
      {preparingComposer ? "Preparing…" : "Check out"}
    </span>
  </Button>
