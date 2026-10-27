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

function srgbToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const converted = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, converted)) * 255);
}

function srgbToOklab(channels: readonly [number, number, number]) {
  const [red = 0, green = 0, blue = 0] = channels.map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ] as const;
}

function oklabToLinearSrgb(lightness: number, a: number, b: number) {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ] as const;
}

function oklabToSrgb(lightness: number, a: number, b: number) {
  const [red, green, blue] = oklabToLinearSrgb(lightness, a, b);
  return [linearToSrgb(red), linearToSrgb(green), linearToSrgb(blue)] as const;
}

function relativeLuminance(channels: readonly [number, number, number]): number {
  const [red, green, blue] = channels.map(srgbToLinear);
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

/**
 * Unlike `readableTextColor`, which blends toward black or white and greys the color out,
 * this moves only OKLCH lightness and takes the most chroma sRGB allows at each step, so a vivid
 * accent stays vivid at the contrast it needs (T3 Code `themeAccentWithContrast`).
 */
export function themeAccentWithContrast(
  accent: string,
  surfaces: ReadonlyArray<string>,
  minimum = 4.5,
): string {
  const accentChannels = rgbChannels(accent);
  const surfaceChannels = surfaces.map(rgbChannels).filter((channels) => channels !== null);
  const minimumContrast = (channels: readonly [number, number, number]) =>
    Math.min(...surfaceChannels.map((surface) => contrastRatio(channels, surface)));
  if (
    !accentChannels ||
    surfaceChannels.length === 0 ||
    minimumContrast(accentChannels) >= minimum
  ) {
    return accent;
  }

  const [lightness, a, b] = srgbToOklab(accentChannels);
  const hue = Math.atan2(b, a);
  const inGamut = (channels: ReadonlyArray<number>) =>
    channels.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);
  const mostVivid = (stepLightness: number) => {
    let chroma = 0;
    let lower = 0;
    let upper = Math.max(Math.hypot(a, b), 0.2);
    for (let index = 0; index < 20; index += 1) {
      const candidate = (lower + upper) / 2;
      if (
        inGamut(
          oklabToLinearSrgb(stepLightness, candidate * Math.cos(hue), candidate * Math.sin(hue)),
        )
      ) {
        chroma = candidate;
        lower = candidate;
      } else {
        upper = candidate;
      }
    }
    return oklabToSrgb(stepLightness, chroma * Math.cos(hue), chroma * Math.sin(hue));
  };

  const lighten = minimumContrast([255, 255, 255]) >= minimumContrast([0, 0, 0]);
  const step = lighten ? 0.002 : -0.002;
  for (let next = lightness; lighten ? next <= 1 : next >= 0; next += step) {
    const candidate = mostVivid(next);
    if (minimumContrast(candidate) >= minimum) {
      return `#${candidate.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
    }
  }
  return lighten ? "#ffffff" : "#000000";
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

/**
 * The terminal a command's output shows in, as desktop's `--solus-terminal-*`:
 * no fill of its own, a hairline ring, and the primary text, so the output
 * reads at full contrast on the surface it sits on; then the eight colours a
 * command prints with (SGR 30–37) and their bright set (90–97), tuned to read
 * on the page in each appearance. Red and yellow are the error and warning
 * tones, so a tool's own red agrees with a line Solus reads as an error.
 */
function terminalVariables(c: ThemeColors, appearance: ThemeAppearance) {
  const dark = appearance === "dark";
  const ansi = dark
    ? { black: "#8d8a83", red: "#f3817b", green: "#6fcf8f", yellow: "#fbbf24", blue: "#7aa2f7", magenta: "#c89bf2", cyan: "#6fd3d8", white: "#f0ede5" }
    : { black: "#57544c", red: "#c9302d", green: "#26894c", yellow: "#b7791f", blue: "#1b4ed8", magenta: "#9333ea", cyan: "#0e7490", white: "#8d8a83" };
  const bright = dark
    ? { black: "#a6a39b", red: "#ff8a86", green: "#8fe3a9", yellow: "#ffd166", blue: "#9cbcff", magenta: "#dbb6ff", cyan: "#93e8ec", white: "#ffffff" }
    : { black: "#7d7a6e", red: "#e0443f", green: "#2fa35c", yellow: "#d29a2b", blue: "#3b6ff0", magenta: "#a855f7", cyan: "#0891b2", white: "#a6a39b" };
  return {
    "--color-terminal-background": "transparent",
    "--color-terminal-foreground": c.text,
    "--color-terminal-muted": c.textMuted,
    "--color-terminal-border": withAlpha(dark ? "#ffffff" : "#000000", 0.14),
    "--color-terminal-error": ansi.red,
    "--color-terminal-warning": ansi.yellow,
    "--color-terminal-ansi-black": ansi.black,
    "--color-terminal-ansi-red": ansi.red,
    "--color-terminal-ansi-green": ansi.green,
    "--color-terminal-ansi-yellow": ansi.yellow,
    "--color-terminal-ansi-blue": ansi.blue,
    "--color-terminal-ansi-magenta": ansi.magenta,
    "--color-terminal-ansi-cyan": ansi.cyan,
    "--color-terminal-ansi-white": ansi.white,
    "--color-terminal-ansi-bright-black": bright.black,
    "--color-terminal-ansi-bright-red": bright.red,
    "--color-terminal-ansi-bright-green": bright.green,
    "--color-terminal-ansi-bright-yellow": bright.yellow,
    "--color-terminal-ansi-bright-blue": bright.blue,
    "--color-terminal-ansi-bright-magenta": bright.magenta,
    "--color-terminal-ansi-bright-cyan": bright.cyan,
    "--color-terminal-ansi-bright-white": bright.white,
  };
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
    // Pull request cards. In light mode a neutral hairline: the beige border
    // reads as sand on the light card.
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
    ...terminalVariables(c, appearance),
    // Desktop's code block border and table rules: the container border at 55-60%.
    "--color-md-block-border": withAlpha(c.input, 0.6),
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
    "--color-drawer": c.canvas,
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
    // +N/−N diff counts, as desktop's `--solus-diff-*-text-vivid`: light mode
    // takes darker inks so a count reads at 4.5:1 on the canvas.
    "--color-diff-added": appearance === "dark" ? c.green : "#047857",
    "--color-diff-removed": appearance === "dark" ? c.errorForeground : "#b91c1c",
    // T3's adaptive status pairs (adaptive-colors.css) in desktop's status hues.
    "--color-adaptive-emerald-600-400": c.green,
    "--color-adaptive-amber-700-300": c.amber,
    "--color-adaptive-amber-700-400": c.amber,
    "--color-adaptive-amber-500-a10-400-a10": withAlpha(c.amber, 0.1),
    "--color-adaptive-amber-500-a25-400-a25": withAlpha(c.amber, 0.25),
    // mobile: working text is desktop's status text tone (`statTintColor`):
    // the blue 58% over the foreground, lighter in dark and darker in light.
    "--color-adaptive-sky-600-400": mixColors(c.blue, c.text, 0.58),
    "--color-adaptive-violet-600-400": c.purple,
    "--color-adaptive-rose-600-400": c.red,
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
