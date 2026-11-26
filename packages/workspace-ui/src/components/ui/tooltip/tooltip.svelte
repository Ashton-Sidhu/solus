<script lang="ts" generics="P = never">
  import { Tooltip as TooltipPrimitive } from "bits-ui";

  let {
    open = $bindable(false),
    disabled,
    ...restProps
  }: TooltipPrimitive.RootProps<P> = $props();

  // bits-ui keeps an open tooltip open when it becomes disabled, and a
  // disabled trigger ignores the pointer that leaves it. Without this, a
  // tooltip that was open when it was disabled stays on screen after the
  // pointer has gone (a session row that was clicked to open its session).
  $effect(() => {
    if (disabled) open = false;
  });
</script>

<TooltipPrimitive.Root bind:open {disabled} {...restProps} />
