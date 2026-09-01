interface LinkActivationModifiers {
  metaKey: boolean;
  ctrlKey: boolean;
}

export function linkActivationAction(
  modifiers: LinkActivationModifiers,
): "open" | "preview" {
  return modifiers.metaKey || modifiers.ctrlKey ? "open" : "preview";
}

export function linkDestinationLabel(href: string): string {
  try {
    const url = new URL(href);
    if (url.protocol === "mailto:") return url.pathname;
    return url.hostname.replace(/^www\./, "") || href;
  } catch {
    return href;
  }
}
