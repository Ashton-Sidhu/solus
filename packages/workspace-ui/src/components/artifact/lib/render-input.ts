import { z } from "zod";
import { localApi } from "@solus/client-core/local-api";
import { KEYBINDINGS, type BindingId } from "../../../lib/keybindings/manifest";
import { effectiveCombo, type BindingOverrides } from "../../../lib/keybindings/editing";
import { comboEquals, comboIsTextInput } from "../../../lib/keybindings/match";
import type { BindingDef, KeyCombo } from "../../../lib/keybindings/types";
import { routeForHref } from "../../../lib/agent-links";
import type { WorkspaceCommands } from "../../../contexts/app/surface-context.svelte";

/**
 * What a render passes up to the app when the reader acts inside it (the
 * forwarders in `@solus/contracts/artifact-sandbox`): a link click, and a key
 * chord that is an app shortcut. The page is agent-authored and can post
 * anything, so every message is untrusted input.
 */

/** A link the reader clicked in a render. Only web and mail links leave it. */
export const artifactLinkMessageSchema = z.object({
  type: z.literal("solus-artifact-link"),
  url: z.string().max(8192).refine(isOpenableRenderUrl),
});

function isOpenableRenderUrl(url: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Open a render's link by the chat link's rule (`MarkdownLink`): a pull
 * request opens in the workspace, and any other link leaves for the system
 * browser. With no workspace, every link leaves.
 */
export function openRenderLink(url: string, workspace: Pick<WorkspaceCommands, "openRoute"> | null): void {
  const route = workspace ? routeForHref(url) : null;
  if (workspace && route) workspace.openRoute(route, { sourceUrl: url });
  else void localApi.openExternal(url);
}

/** A chord the page claimed as an app shortcut and passed on. */
export const artifactKeyMessageSchema = z.object({
  type: z.literal("solus-artifact-key"),
  code: z.string().max(64),
  key: z.string().max(64),
  metaKey: z.boolean(),
  ctrlKey: z.boolean(),
  altKey: z.boolean(),
  shiftKey: z.boolean(),
  repeat: z.boolean(),
});
export type ArtifactKeyMessage = z.infer<typeof artifactKeyMessageSchema>;

/** A chord with `mod` resolved to the platform's key, as the page compares it. */
export interface RenderChord {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Commands that still answer while a focused render holds the keyboard. A
 * page script can post any chord it likes, so each one only changes what the
 * reader sees: none sends, creates, stops, or changes a session.
 */
const RENDER_SHORTCUT_BINDINGS: ReadonlySet<BindingId> = new Set<BindingId>([
  "global.command-palette",
  "global.go-to-file",
  "global.project-search",
  "global.session-picker",
  "global.session-picker-j",
  "global.task-picker",
  "global.show-shortcuts",
  "global.focus-input",
  "global.toggle-sidebar",
  "global.toggle-project-panel",
  "pane.maximize",
  "global.toggle-diff-panel",
  "global.toggle-files",
  "global.toggle-workspace",
  "global.toggle-tasks",
  "global.toggle-automations",
  "global.toggle-notifications",
  "global.toggle-insights",
  "global.history-back",
  "global.history-forward",
  "global.next-tab",
  "global.prev-tab",
  "global.next-session",
  "global.prev-session",
]);

/** Every combo that fires a binding, as the dispatcher reads them: an
 *  override keeps the built-in aliases, and a removed shortcut has none. */
function combosOf(id: BindingId, def: BindingDef, overrides: BindingOverrides): KeyCombo[] {
  const combo = effectiveCombo(id, overrides);
  if (combo === null) return [];
  return overrides[id] === null ? [combo] : [combo, ...(def.aliases ?? [])];
}

function resolveChord(combo: KeyCombo, isMac: boolean): RenderChord {
  return {
    code: combo.code,
    metaKey: !!combo.meta || (!!combo.mod && isMac),
    ctrlKey: !!combo.ctrl || (!!combo.mod && !isMac),
    altKey: !!combo.alt,
    shiftKey: !!combo.shift,
  };
}

let cached: { overrides: BindingOverrides; isMac: boolean; chords: RenderChord[] } | null = null;

/**
 * The chords a render may pass on: the allowed commands' keys, in the
 * reader's bindings. A chord that any other command also uses, in any scope,
 * stays with the page, so a forged key reaches only an allowed command. A
 * chord with no ⌘, ⌃, or ⌥ is typing, so it stays with the page too.
 */
export function renderShortcutChords(overrides: BindingOverrides, isMac: boolean): RenderChord[] {
  if (cached?.overrides === overrides && cached.isMac === isMac) return cached.chords;
  const allowed: KeyCombo[] = [];
  const blocked: KeyCombo[] = [];
  // SAFETY: KEYBINDINGS is a closed const object whose keys define BindingId.
  for (const [id, def] of Object.entries(KEYBINDINGS) as Array<[BindingId, BindingDef]>) {
    (RENDER_SHORTCUT_BINDINGS.has(id) ? allowed : blocked).push(...combosOf(id, def, overrides));
  }
  const chords: RenderChord[] = [];
  for (const combo of allowed) {
    if (comboIsTextInput(combo) || !(combo.mod || combo.meta || combo.ctrl || combo.alt)) continue;
    if (blocked.some((other) => comboEquals(combo, other))) continue;
    const chord = resolveChord(combo, isMac);
    if (!isRenderShortcut(chords, chord)) chords.push(chord);
  }
  cached = { overrides, isMac, chords };
  return chords;
}

/** Whether a pressed key is exactly one of the chords. */
export function isRenderShortcut(chords: readonly RenderChord[], pressed: RenderChord): boolean {
  return chords.some(
    (chord) =>
      chord.code === pressed.code &&
      chord.metaKey === pressed.metaKey &&
      chord.ctrlKey === pressed.ctrlKey &&
      chord.altKey === pressed.altKey &&
      chord.shiftKey === pressed.shiftKey,
  );
}
