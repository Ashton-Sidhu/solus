import { tv } from '@solus/workspace-ui/lib/tw'

/**
 * The one row shape every menu in the app is built from — dropdown, context
 * menu, select, command list. Seven primitives used to carry near-identical
 * copies of this class list, so a metric change meant seven edits and the
 * copies drifted.
 *
 * A 32px row carrying the `--text-menu` label. Touch steps up to a 44px
 * *floor*: a 32px row is below the hit target a finger needs, and every menu in
 * the app is a menu on a phone too.
 *
 * A row whose description wraps — a publish destination explaining why it is
 * unavailable — has to grow instead of spilling its second line into the row
 * above it. The base `h-8` is a plain utility, so a call site's `h-auto` evicts
 * it through tailwind-merge.
 *
 * Selection state (spine, ink, hover wash) lives in the `menu-row` utility
 * in `index.css`, because it needs `::before` and state selectors that
 * utilities can't express.
 *
 * Per-primitive concerns — icon sizing, inset padding, destructive colouring,
 * `group/*` names — stay at the call site; only what is genuinely shared is here.
 */
export const menuRowVariants = tv({
  base: 'menu-row flex cursor-default select-none items-center outline-hidden h-8 gap-2.5 rounded-lg text-menu text-(--solus-text-secondary) pointer-coarse:h-auto pointer-coarse:min-h-11 pointer-coarse:py-2 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  variants: {
    /** Rows with an absolutely-positioned check reserve the room for it. */
    indicator: {
      none: 'px-2.5',
      trailing: 'pr-8 pl-2.5',
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
