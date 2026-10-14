/**
 * T3 Code's mobile token derivation (`apps/mobile/src/lib/mobileTheme.ts`,
 * MIT, see UPSTREAM.md), run on the Solus palette (`theme-colors.ts`). Every
 * T3 component reads these tokens, so T3's interface keeps its relationships
 * (grouped cards, composer glass, readable muted text) in Solus's colors.
 *
 * Local changes: only the default theme, no OKLCH conversion (the Solus
 * palette is sRGB), and no theme library.
 */
import { themeColorsFor, type ThemeAppearance, type ThemeColors } from '../theme/theme-colors'

/** Solus has one theme; T3's theme library is not adopted. */
export const DEFAULT_MOBILE_THEME_ID = 'solus' as const;
export type MobileThemeId = typeof DEFAULT_MOBILE_THEME_ID;
export type MobileThemeAppearance = ThemeAppearance;
export type MobileThemeMode = MobileThemeAppearance | 'system';

function withAlpha(color: string, alpha: number): string {
  const hex = color.startsWith("#") ? color.slice(1) : "";
  if (hex.length !== 6) return color;
  const [red, green, blue] = [0, 2, 4].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  );
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function rgbChannels(color: string): readonly [number, number, number] | null {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})(?:[\da-f]{2})?$/i.exec(color);
  if (!match) return null;
  const [, red = "0", green = "0", blue = "0"] = match;
  return [Number.parseInt(red, 16), Number.parseInt(green, 16), Number.parseInt(blue, 16)];
}

function relativeLuminance(channels: readonly [number, number, number]): number {
  const [red, green, blue] = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrastRatio(
  first: readonly [number, number, number],
  second: readonly [number, number, number],
): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

/** Preserve the color's hue while giving text 4.5:1 contrast on every supplied surface. */
function readableTextColor(accent: string, surface: string | ReadonlyArray<string>): string {
  const accentChannels = rgbChannels(accent);
  const surfaceChannels = (typeof surface === "string" ? [surface] : surface)
    .map(rgbChannels)
    .filter((channels) => channels !== null);
  const minimumContrast = (channels: readonly [number, number, number]) =>
    Math.min(...surfaceChannels.map((surface) => contrastRatio(channels, surface)));
  if (!accentChannels || surfaceChannels.length === 0 || minimumContrast(accentChannels) >= 4.5) {
    return accent;
  }

  const black = [0, 0, 0] as const;
  const white = [255, 255, 255] as const;
  const target = minimumContrast(black) >= minimumContrast(white) ? black : white;
  let readable: readonly [number, number, number] = target;
  let lowerAmount = 0;
  let upperAmount = 1;
  for (let index = 0; index < 12; index += 1) {
    const amount = (lowerAmount + upperAmount) / 2;
    const candidate: readonly [number, number, number] = [
      Math.round(accentChannels[0] + (target[0] - accentChannels[0]) * amount),
      Math.round(accentChannels[1] + (target[1] - accentChannels[1]) * amount),
      Math.round(accentChannels[2] + (target[2] - accentChannels[2]) * amount),
    ];
    if (minimumContrast(candidate) >= 4.5) {
      readable = candidate;
      upperAmount = amount;
    } else {
      lowerAmount = amount;
    }
  }
  return `#${readable.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** `color-mix(in srgb, first weight, second)` for two opaque hex colors. */
function mixColors(first: string, second: string, weight: number): string {
  const firstChannels = rgbChannels(first);
  const secondChannels = rgbChannels(second);
  if (!firstChannels || !secondChannels) return first;
  return `#${firstChannels
    .map((channel, index) => Math.round(channel * weight + secondChannels[index]! * (1 - weight)))
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function themeColorWithAlpha(color: string, alpha: number): string {
  const channels = rgbChannels(color);
  if (channels) {
    return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(color);
  return rgb ? `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})` : color;
}

export function createMobileThemeVariables(
  colors: ThemeColors,
  appearance: ThemeAppearance,
  groupedCardColor = colors.surface,
  prominentAction: readonly [string, string] = [colors.text, colors.canvas],
) {
  const c = colors;
  const groupedCard = groupedCardColor;
  const textSurfaces = [c.canvas, c.surface, c.surfaceRaised, c.chrome, groupedCard];
  return {
    "--color-screen": c.canvas,
    "--color-sheet": withAlpha(c.chrome, 0.98),
    "--color-sheet-solid": c.chrome,
    "--color-card": c.surface,
    "--color-grouped-card": groupedCard,
    "--color-card-alt": c.surfaceRaised,
    "--color-card-translucent": withAlpha(c.surface, 0.8),
    "--color-thread-canvas": c.canvas,
    "--color-thread-selected": c.sidebarRowActive,
    "--color-thread-selected-foreground": c.sidebarForeground,
    "--color-thread-selected-foreground-muted": readableTextColor(
      c.sidebarMutedForeground,
      c.sidebarRowActive,
    ),
    "--color-thread-hover": c.sidebarRowHover,
    "--color-row-hover": c.toolbarControlHover,
    "--color-composer-panel": themeColorWithAlpha(c.canvas, appearance === "dark" ? 0.92 : 0.88),
    // The Solus input pill: its own surface and the container's ring, not T3's
    // tonal glass (`--solus-input-pill-bg`, `--solus-container-border`).
    "--color-composer-surface": c.composerSurface,
    "--color-composer-border": c.input,
    // The Solus composer's drop: a soft shadow in light, none in dark.
    "--color-composer-shadow": appearance === "dark" ? "rgba(0, 0, 0, 0)" : "rgba(0, 0, 0, 0.08)",
    "--color-foreground": c.text,
    "--color-foreground-secondary": readableTextColor(c.textMuted, textSurfaces),
    "--color-foreground-muted": readableTextColor(c.mutedForeground, textSurfaces),
    "--color-foreground-tertiary": c.secondaryLabel,
    "--color-border": c.border,
    "--color-focus": c.focus,
    "--color-border-subtle": withAlpha(c.border, 0.7),
    "--color-separator": withAlpha(c.border, 0.55),
    "--color-subtle": c.muted,
    // A neutral overlay, not a palette tone: it sits one step off any surface
    // under it. The palette tone was beige on the light card and the card
    // color itself in dark mode.
    "--color-subtle-strong": appearance === "dark" ? "rgba(255, 255, 255, 0.07)" : "rgba(0, 0, 0, 0.05)",
    // Pull request tabs and cards. The selected tab is the page color, so it
    // is lighter than its track in light mode and darker in dark mode, as in
    // T3 Code. In light mode a neutral hairline: the beige border reads as sand
    // on the light card.
    "--color-pr-tab-track": groupedCard,
    "--color-pr-tab-selected": c.canvas,
    "--color-pr-card": groupedCard,
    "--color-pr-card-border": appearance === "light" ? "rgba(0, 0, 0, 0.06)" : withAlpha(c.border, 0.7),
    "--color-inline-skill-background": c.accentSurface,
    "--color-inline-skill-border": withAlpha(c.accent, 0.42),
    "--color-inline-skill-foreground": c.accentSurfaceForeground,
    "--color-primary": c.messageAction,
    "--color-prominent-action": prominentAction[0],
    "--color-prominent-action-foreground": prominentAction[1],
    "--color-primary-foreground": c.messageActionForeground,
    "--color-primary-text": readableTextColor(c.messageAction, textSurfaces),
    "--color-primary-shadow": "#000000",
    "--color-secondary": c.secondary,
    "--color-secondary-foreground": c.secondaryForeground,
    "--color-secondary-border": c.border,
    "--color-switch-active-track": c.messageAction,
    "--color-switch-active-thumb": c.messageActionForeground,
    "--color-switch-inactive-track": c.secondary,
    "--color-switch-inactive-thumb": c.mutedForeground,
    "--color-warning": c.warningSurface,
    "--color-warning-border": withAlpha(c.warning, 0.32),
    "--color-warning-foreground": c.warningForeground,
    "--color-danger": c.errorSurface,
    "--color-danger-border": withAlpha(c.error, 0.32),
    "--color-danger-foreground": c.errorForeground,
    "--color-update": c.updateSurface,
    "--color-update-foreground": c.updateForeground,
    "--color-input": c.surface,
    "--color-input-border": c.input,
    "--color-sidebar-search": c.sidebarControlSurface,
    "--color-placeholder": readableTextColor(c.placeholder, textSurfaces),
    "--color-icon": c.text,
    "--color-icon-muted": c.iconMuted,
    "--color-icon-subtle": c.secondaryLabel,
    "--color-header": withAlpha(c.toolbar, 0.97),
    "--color-header-foreground": c.toolbarForeground,
    "--color-header-border": c.toolbarBorder,
    "--color-glass-surface": withAlpha(c.surfaceOverlay, 0.74),
    "--color-glass-fallback": themeColorWithAlpha(groupedCard, appearance === "dark" ? 0.9 : 0.94),
    "--color-glass-tint": withAlpha(c.surfaceOverlay, 0.22),
    "--color-status-bar": c.canvas,
    "--color-md-body": c.text,
    "--color-md-strong": c.text,
    "--color-md-link": readableTextColor(c.messageAction, c.canvas),
    "--color-md-blockquote-border": c.border,
    "--color-md-blockquote-bg": c.muted,
    "--color-md-code-bg": c.codeBackground,
    "--color-md-code-text": c.codeForeground,
    // Desktop's `.prose-cloud pre` and `.solus-code-block` border: the container border at 60%.
    "--color-md-code-border": withAlpha(c.input, 0.6),
    // Desktop's `.prose-cloud code`: the accent toned 72% toward the text color.
    "--color-md-inline-code": mixColors(c.accent, c.text, 0.72),
    "--color-md-user-code-bg": withAlpha(c.messageForeground, 0.18),
    "--color-md-user-code-text": c.messageForeground,
    "--color-md-user-fence-bg": withAlpha("#000000", appearance === "dark" ? 0.28 : 0.16),
    "--color-md-user-fence-text": c.messageForeground,
    "--color-md-hr": c.border,
    "--color-user-bubble": c.messageSurface,
    "--color-user-bubble-foreground": c.messageForeground,
    "--color-user-bubble-foreground-muted": withAlpha(c.messageForeground, 0.78),
    "--color-user-bubble-skill-foreground": readableTextColor(c.messageAction, c.messageSurface),
    "--color-backdrop": withAlpha("#000000", appearance === "dark" ? 0.48 : 0.22),
    "--color-drawer": c.sidebar,
    "--color-drawer-foreground": c.sidebarForeground,
    "--color-drawer-foreground-muted": readableTextColor(c.sidebarMutedForeground, [
      c.sidebar,
      c.sidebarRowHover,
    ]),
    "--color-drawer-border": c.sidebarBorder,
    "--color-drawer-shadow": withAlpha("#000000", appearance === "dark" ? 0.32 : 0.12),
    "--color-dot-separator": withAlpha(c.textMuted, 0.35),
    "--color-wordmark": c.text,
    "--color-chevron": withAlpha(c.textMuted, 0.42),
  };
}


export type MobileThemeVariable = keyof ReturnType<typeof createMobileThemeVariables>;
export type MobileThemeVariables = Readonly<Record<MobileThemeVariable, string>>;

/** The full token set for one appearance. The screen is the app background.
 *  Grouped cards take a light neutral fill in light mode: desktop's `--muted`
 *  is a see-through 6% ink wash for hover, and laid flat as an opaque card it
 *  reads as grey. In dark mode they take the raised card. */
/** mobile: the light grouped card, lighter than desktop's flattened `--muted` (#f2f2ef). */
const LIGHT_GROUPED_CARD = "#fafaf9";

export function getMobileThemeVariables(appearance: ThemeAppearance): MobileThemeVariables {
  const colors = themeColorsFor(appearance);
  const groupedCard = appearance === "light" ? LIGHT_GROUPED_CARD : colors.sidebarRowActive;
  return createMobileThemeVariables(colors, appearance, groupedCard);
}
