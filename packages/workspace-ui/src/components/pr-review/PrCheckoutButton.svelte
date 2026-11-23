<script lang="ts">
  import * as Tooltip from "../ui/tooltip";
  import { LoaderCircle as CircleNotchIcon } from "@lucide/svelte";
  import { GitPullRequestIcon } from "../ui/octicons";
  import { Button } from "../ui/button";
  let { preparingComposer, disabled, onclick }: {
    preparingComposer: boolean;
    disabled: boolean;
    onclick: () => void;
  } = $props();
</script>

<Tooltip.Root>
  <Tooltip.Trigger onclick={onclick}>
    {#snippet child({ props })}
      <Button
        {...props}
        type="button"
        variant="ghost"
        size="xs"
        class="disabled:pointer-events-auto h-7 shrink-0 gap-1.5 rounded-full px-2.5 text-workspace-chrome font-normal text-foreground hover:bg-[var(--wash-1)] pointer-coarse:tap-area @max-[54rem]/band:px-[5px] @max-[54rem]/band:pointer-coarse:px-[12.5px]"
        disabled={preparingComposer || disabled}
        aria-label="Check out this pull request"
      >
        {#if preparingComposer}
          <CircleNotchIcon
            class="size-3 animate-spin [animation-duration:0.9s]"
            aria-hidden="true"
          />
        {:else}
          <GitPullRequestIcon class="size-[15px]" aria-hidden="true" />
        {/if}
        <span class="@max-[54rem]/band:hidden">
          {preparingComposer ? "Preparing…" : "Check out"}
        </span>
      </Button>
    {/snippet}
  </Tooltip.Trigger>
  <Tooltip.Content
    side="bottom"
    value={preparingComposer ? "Preparing checkout…" : "Check out this pull request"}
  />
</Tooltip.Root>
