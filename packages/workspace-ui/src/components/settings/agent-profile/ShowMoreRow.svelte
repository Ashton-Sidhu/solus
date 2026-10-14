<script lang="ts">
  /** The last row of a long list: the rows not shown, and the way to show them or fold them again. */
  import { Button } from "../../ui/button";

  interface Props {
    hiddenCount: number;
    expanded: boolean;
    /** What the rows are, plural: "skills". */
    noun: string;
    onToggle: () => void;
  }

  let { hiddenCount, expanded, noun, onToggle }: Props = $props();
</script>

{#if hiddenCount > 0 || expanded}
  <div class="flex justify-center px-4 py-2">
    <Button variant="ghost" size="sm" class="text-muted-foreground" onclick={onToggle}>
      {expanded ? `Show fewer ${noun}` : `Show ${hiddenCount} more`}
    </Button>
  </div>
{/if}
