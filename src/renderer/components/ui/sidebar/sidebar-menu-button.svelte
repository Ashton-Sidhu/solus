<script lang="ts" module>
  import { tv, type VariantProps } from "tailwind-variants";

  export const sidebarMenuButtonVariants = tv({
    base: "peer/menu-button group/menu-button flex w-full items-center gap-2 overflow-hidden rounded-lg px-2.5 text-left text-sm outline-none transition-[color,background-color,transform] duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:pointer-events-none disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground [&_svg]:shrink-0 [&>span:last-child]:truncate",
    variants: {
      variant: {
        default: "",
        outline: "border border-sidebar-border bg-transparent",
      },
      size: {
        sm: "h-7 text-xs",
        default: "h-8 text-[0.8125rem]",
        lg: "h-10 text-sm",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  });

  export type SidebarMenuButtonVariant = VariantProps<typeof sidebarMenuButtonVariants>["variant"];
  export type SidebarMenuButtonSize = VariantProps<typeof sidebarMenuButtonVariants>["size"];
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  import { cn, type WithElementRef } from "@renderer/lib/utils";

  let {
    ref = $bindable(null),
    class: className,
    children,
    variant = "default",
    size = "default",
    isActive = false,
    type = "button",
    ...restProps
  }: WithElementRef<HTMLButtonAttributes, HTMLButtonElement> & {
    children?: Snippet;
    variant?: SidebarMenuButtonVariant;
    size?: SidebarMenuButtonSize;
    isActive?: boolean;
  } = $props();
</script>

<button
  bind:this={ref}
  data-slot="sidebar-menu-button"
  data-sidebar="menu-button"
  data-size={size}
  data-active={isActive ? "true" : undefined}
  class={cn(sidebarMenuButtonVariants({ variant, size }), className)}
  {type}
  {...restProps}
>
  {@render children?.()}
</button>
