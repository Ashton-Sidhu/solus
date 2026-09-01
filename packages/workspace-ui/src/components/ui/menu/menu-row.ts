import { tv } from '@solus/workspace-ui/lib/tw'

/**
 * The one row shape every menu in the app is built from — dropdown, context
 * menu, select, command list. Seven primitives used to carry near-identical
 * copies of this class list, so a metric change meant seven edits and the
 * copies drifted.
 *
 * A 32px row carrying the `--text-menu` label, stepping to a 28px row and 11px
 * on a precise-pointer laptop. The row has to step with its type: shrinking the
 * label alone just grows the empty band around it, which is what made a laptop
 * menu read as a desktop menu that had been zoomed out. Touch steps the other
 * way, to a 44px *floor*: a 32px row is below the hit target a finger needs,
 * and every menu in the app is a menu on a phone too. A floor rather than a
 * fixed height, because a row whose description wraps on a narrow screen — a
 * publish destination explaining why it is unavailable — has to grow instead of
 * spilling its second line into the row beneath it.
 *
 * Selection state (spine, weight, hover wash) lives in the `menu-row` utility
 * in `index.css`, because it needs `::before` and state selectors that
 * utilities can't express.
 *
 * Per-primitive concerns — icon sizing, inset padding, destructive colouring,
 * `group/*` names — stay at the call site; only what is genuinely shared is here.
 */
export const menuRowVariants = tv({
  base: 'menu-row flex cursor-default select-none items-center outline-hidden h-8 gap-2.5 rounded-lg text-menu text-(--solus-text-secondary) pointer-coarse:h-auto pointer-coarse:min-h-11 pointer-coarse:py-2 pointer-fine:[.is-laptop-display_&]:h-7 pointer-fine:[.is-laptop-display_&]:gap-2 pointer-fine:[.is-laptop-display_&]:rounded-md data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  variants: {
    /** Rows with an absolutely-positioned check reserve the room for it. */
    indicator: {
      none: 'px-2.5 pointer-fine:[.is-laptop-display_&]:px-2',
      trailing: 'pr-8 pl-2.5 pointer-fine:[.is-laptop-display_&]:pr-7 pointer-fine:[.is-laptop-display_&]:pl-2',
    },
    /**
     * Entry stagger, for menus that animate open. Off for submenu triggers and
     * command rows, whose lists re-render as the user types — restarting the
     * animation on every keystroke reads as flicker.
     */
    stagger: {
      true: 'menu-item-stagger',
      false: '',
    },
  },
  defaultVariants: { indicator: 'none', stagger: true },
})
