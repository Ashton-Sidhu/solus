<script lang="ts">
  import { Check } from "@lucide/svelte";
  import * as Popover from "../ui/popover";

  let { label = "All edits saved" }: { label?: string } = $props();
</script>

<Popover.Root>
  <Popover.Trigger
    title={label}
    aria-label={label}
    class="inline-flex size-6.5 shrink-0 items-center justify-center rounded-full border-0 bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) focus-visible:outline-2 focus-visible:outline-(--solus-accent-border) pointer-coarse:size-11"
    data-testid="work-saved-status"
  >
    <Check size={16} aria-hidden="true" />
  </Popover.Trigger>
  <Popover.Content side="bottom" align="start" class="w-auto rounded-lg px-3 py-2 text-workspace-chrome">
    {label}
  </Popover.Content>
</Popover.Root>
