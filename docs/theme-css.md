# Theme CSS

A person can restyle Solus with custom CSS. They can write it in
**Settings › Appearance › Custom theme**, or they can ask an agent to write it.
The desktop and web clients apply the change immediately. A reload is not necessary.

## Ownership

The CSS is a personal setting, `themeCss`. It is stored beside `themeMode`.
It follows the person to each of their clients, and to the account when sync is
on (plans/018). One theme is active. Solus has no gallery of saved themes.

The phone app does not apply theme CSS, because React Native does not use CSS.
This is a platform exception. The phone app keeps the value and syncs it, but
it does not show it. The phone app follows `themeMode` only.

## How an agent changes the theme

1. The agent calls `read_theme`. The tool returns the person's current
   `themeMode` and `themeCss`, and the guide. The guide lists the color tokens and
   the stable selectors (`THEME_GUIDE` in `packages/contracts/src/theme-css.ts`).
2. The agent calls `update_theme` with `css`, the whole CSS. It can set
   `appearance` (light, dark, or system) in the same call, or alone.
   `update_config` with `{ personal: { themeCss, themeMode } }` does the same.
3. The host sends the change to one of the person's clients. That client applies
   it as a local edit, and sync sends it to the other clients (docs/settings.md).

An empty string removes the CSS. The person can also select **Clear** in Settings.
The tool description tells the agent to change the theme only when the person asks.

T3 Code can publish a theme under an id and switch between themes by id. Solus
does not have this: each person has one custom theme, and no gallery of saved
themes. `update_theme` replaces that one theme. A change goes to all clients of
the person through sync, not only to the clients on one machine.

## What theme CSS can rely on

- **Color tokens.** `THEME_COLOR_TOKENS` lists the `--solus-*` tokens that
  theme CSS can set. The other colors of the app derive from them. Set a token on
  `:root` for both appearances, or on `.light` or `.dark` for one.
- **Stable selectors.** `THEME_CSS_HOOKS` lists the regions and primitives. Each
  one is a `[data-slot="…"]` attribute, for example `[data-slot="composer"]`
  and `[data-slot="user-message"]`. Other class names are Tailwind utilities, and
  they change between releases.

`tests/unit/theme-css.test.ts` fails when a listed slot leaves the workspace UI
source, or when a listed token is not set for light and dark. If you rename one,
change the list and the guide in the same change.

When you add a major region to the workspace UI, give it a `data-slot` and add
it to `THEME_CSS_HOOKS`.

## Safety

Theme CSS comes from agents and from pastes. It must not load a file, because a
`url()` on an attribute selector can send what is on screen to another host.

- The personal setting refuses CSS that contains `@import`, `image-set()`,
  `src()`, or a `url()` that is not `data:` or `#id` (`themeCssLoadsFiles`). This
  text check gives early feedback. CSS escapes can get past it.
- The client is the guard (`contexts/app/theme-css.ts`). It puts the CSS in one
  adopted stylesheet, which cannot hold `@import`. The browser parses the CSS
  first. Then the client removes each declaration that can load a file, and each
  value that still has a backslash. It checks rules in `@media`, `@supports`,
  `@layer`, and nested rules, the frames of `@keyframes`, and the initial value of
  `@property`. It removes each at-rule that it cannot check.

The guard removes the known ways to load a file. It does not prove that no other
way exists.

## Limits

- `themeCss` holds 20,000 characters. An embedded image must be about 10 KB or
  smaller.
- Some app rules are more specific than a theme rule, and some surfaces set their
  color inline. Such a rule needs `!important`.
- The agent cannot see the result. The guide tells it to make small changes and
  to ask the person.
- The CSS applies after the app starts, so the layout can move once at startup.
