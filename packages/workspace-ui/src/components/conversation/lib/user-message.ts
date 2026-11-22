import type { PromptSender } from "@solus/contracts/types";

const COLLAPSED_CHARACTER_LIMIT = 700;
const COLLAPSED_LINE_LIMIT = 12;

/**
 * Keep routine prompts scannable while giving pasted specs and logs a compact
 * footprint in the transcript. Explicit lines catch short, vertically long
 * content that a character limit alone would miss.
 */
export function shouldCollapseUserMessage(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;

  return (
    trimmed.length > COLLAPSED_CHARACTER_LIMIT ||
    trimmed.split(/\r?\n/).length > COLLAPSED_LINE_LIMIT
  );
}

/** The first line of a prompt: what its folded row shows. */
export function promptSummary(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] ?? "";
}

/** A sender's name as it reads now, else as it read when it sent, else its kind. */
export function promptSenderLabel(sender: PromptSender, currentName?: string): string {
  const sentName = sender.kind === "agent" ? sender.title : sender.name;
  return currentName?.trim() || sentName?.trim() || (sender.kind === "agent" ? "Agent" : "Automation");
}
