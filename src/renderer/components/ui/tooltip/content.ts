export type TooltipValue =
  | string
  | {
      label: string;
      shortcut?: string;
    }
  | null;

export interface TooltipDisplay {
  label: string;
  shortcut?: string;
}

const SHORTCUT_TOKEN =
  /(?:⌘|⌥|⇧|⌃|↵|⏎|←|→|\bEnter\b|\bEscape\b|\bEsc\b|\bOpt\b|\bShift\b|\bCtrl\b)/i;

export function tooltipDisplay(value: TooltipValue): TooltipDisplay | null {
  if (!value) return null;
  if (value instanceof Object) {
    const label = value.label.trim();
    if (!label) return null;
    const shortcut = value.shortcut?.trim();
    return shortcut ? { label, shortcut } : { label };
  }

  const label = value.trim();
  if (!label) return null;

  const parenthetical = label.match(/^(.*?)\s+\(([^()]*)\)$/);
  if (parenthetical && SHORTCUT_TOKEN.test(parenthetical[2])) {
    return {
      label: parenthetical[1].trim(),
      shortcut: parenthetical[2].trim(),
    };
  }

  const separated = label.match(/^(.*?)\s+·\s+(.+)$/);
  if (separated && SHORTCUT_TOKEN.test(separated[2])) {
    return {
      label: separated[1].trim(),
      shortcut: separated[2].trim(),
    };
  }

  return { label };
}
