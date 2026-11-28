# Buttons in Settings

Every button on the settings page and in the dialogs that open from it follows these rules. A button with the same job looks and feels the same on every settings tab.

## Surface

- Use `Button` from `components/ui/button`. Use a raw `<button>` only for a control that does not look like a button: a tile, a tab, a row that opens a page, a filter chip, or a text link inside a sentence.
- The settings page root and each settings dialog set `settings-controls` (`workspace.css`) one time. It gives every outline button and picker trigger the same field surface: the input border, a white fill (a translucent fill in dark mode), and a small shadow. An outline action button gets a hover fill. A picker trigger (`aria-haspopup`) does not.
- Do not add colour, border, fill, shadow, or font-weight classes to a `Button` (`text-destructive`, `border-border/70`, `shadow-xs`, `bg-white`, `font-normal`). The two permitted colour classes are `text-muted-foreground` on a ghost button, and `hover:text-destructive` on an icon button that removes something.
- Do not set a text size on a `Button`. In the settings page, a button inherits the size of its parent (`[&_button]:text-[length:inherit]` on the page root). Do not put a button in a parent that sets a smaller text size.
- Layout classes are permitted: `shrink-0`, `self-start`, `ml-auto`, `-ml-2` (to align a ghost button with text), widths, and `justify-between`.

## Size

| Button                                                        | Size                                     |
| ------------------------------------------------------------- | ---------------------------------------- |
| Text button                                                   | `size="sm"` (28px)                       |
| Icon button                                                   | `size="icon-sm"` (28px)                  |
| Button on the same line as an input or text field             | `size="default"` or `size="icon"` (32px, the field height) |
| Icon button inside a field (clear, show, copy)                | `size="icon-xs"`                         |
| Picker trigger (shows the current value and opens a menu)     | `SettingsSelect`, or `variant="outline" size="sm"` with `h-8 justify-between gap-1.5 rounded-lg px-2.5 font-normal` |

Do not use `xs`, `lg`, or `icon-lg`. Do not set `h-*`, `px-*`, or `rounded-*` on a button, except on a picker trigger.

## Variant

| Job                                                                                                     | Variant                                     |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Complete a form or a dialog: Save, Submit, Add, Create, Connect, Continue, Import. One for each form.    | `default`                                   |
| Any other action: a row action, a section action, Retry, Refresh, Export, Copy, Sign in, Edit, Reset     | `outline`                                   |
| Dismiss: Cancel, Close, Done, Keep, Not now, Discard (an unsaved draft)                                  | `ghost` + `text-muted-foreground`           |
| A quiet action below a list in a row body: Add variable, Add header, Show more, Change                   | `ghost` + `text-muted-foreground`           |
| Delete or remove data or access: Delete, Remove, Disconnect, Sign out, Leave, Revoke, Uninstall, Clear  | `destructive`, on the first button and on the confirm button |
| Icon button                                                                                             | `ghost` + `text-muted-foreground`           |
| Icon button that removes one item of a list                                                             | `ghost` + `text-muted-foreground hover:text-destructive` |

A remove action that repeats on each item of a list is an icon button. A remove action for the one thing that a row or page shows (a codebase, an account, a policy) is a `destructive` text button.

## Groups

Put the buttons of a form or dialog at the trailing edge, `gap-2`, in this order: the dismiss button, then the button that completes. A confirm group is `Cancel` (ghost), then the destructive button.

## Touch

- A text button adds `pointer-coarse:min-h-11`.
- An icon button adds `pointer-coarse:tap-area`.

Write `pointer-coarse:`, not `[@media(pointer:coarse)]:`.
