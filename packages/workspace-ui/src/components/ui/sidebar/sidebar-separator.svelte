<script lang="ts">
  import type { ComponentProps } from "svelte";
  import { cn } from "@solus/workspace-ui/lib/utils";
  import { Separator } from "@solus/workspace-ui/components/ui/separator";

  let { class: className, ...restProps }: ComponentProps<typeof Separator> = $props();
</script>

<Separator
  data-slot="sidebar-separator"
  data-sidebar="separator"
  class={cn("mx-2 w-auto bg-sidebar-border", className)}
  {...restProps}
/>
