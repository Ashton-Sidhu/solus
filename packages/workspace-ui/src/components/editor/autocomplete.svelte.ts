// Unified reference-autocomplete state machine, decoupled from any editor host.
//
// Three trigger characters and one index behind them: `/` is verbs, `@` is
// files, `#` is every other noun in the workspace — plans, docs, pull requests,
// sessions, tasks, automations. Kind is a level you drill into, never a menu you
// pick first, and drilling writes `#automations/` into the composer text rather
// than into state, so undo, caret movement and selection work for free.
//
// Editor mechanics sit behind AutocompleteEditor so the same machine drives the
// CodeMirror prompt input and the Tiptap document editor without leaking either
// editor's transaction model.
import { planKey } from "@solus/contracts/types";
import type {
  AgentId,
  FileMatch,
  PlanReference,
  PluginCommandsResult,
  SessionReference,
  WorkReference,
} from "@solus/contracts/types";
import {
  SLASH_COMMANDS,
  codexSlashCommands,
  type SlashCommand,
  type CategorizedSlashCommands,
} from "../input/slash-commands";
import { type WorkspaceContext, type PlanStore } from "../../contexts";
import type { PrsStore } from "../../contexts/prs/prs.store.svelte";
import {
  autocompleteSelectionAction,
  type AutocompleteEditor,
} from "./autocomplete-editor";
import { GLYPH, KINDS, kindFor, type RefKind } from "./unified-autocomplete/kinds";
import {
  buildRows,
  ghostFor,
  isSelectable,
  sessionPreviewFor,
  type MenuItem,
  type MenuRow,
  type SelectableRow,
} from "./unified-autocomplete/rows";
import {
  findAnchor,
  readTrigger,
  triggerRunPattern,
  type Trigger,
} from "./unified-autocomplete/trigger";
import { ReferenceIndex } from "./unified-autocomplete/reference-index.svelte";
import { autocompleteSessionChangedFiles } from "./autocomplete-scope";
import { serverConnections } from "@solus/client-core/server-connections";

export { filterPlanAutocompleteDescriptors } from "./unified-autocomplete/reference-index.svelte";

/** Everything the controller needs from its host. Reactive props are passed as
 *  getters so reads stay reactive across the module boundary. */
export interface AutocompleteDeps {
  readOnly: () => boolean;
  /** Tab whose server owns autocomplete RPCs. */
  tabId: () => string;
  /** Host selected by a run before it has a tab. */
  serverId?: () => string | undefined;
  /** Session whose changed files belong in "Open in this session". A draft or
   *  detached editor has no session and therefore no session-file group. */
  sessionId?: () => string | undefined;
  workingDirectory: () => string | undefined;
  useRelativeFilePaths: () => boolean;
  provider: () => AgentId;
  includeSolusCommands: () => boolean;
  pluginCommands: () => PluginCommandsResult;
  /** When false, the `/` channel is disabled so the host's own block-command
   *  menu (the document editor) keeps `/`. Defaults to enabled when absent. */
  enableSlash?: () => boolean;
  onSolusCommand: () => ((cmd: SlashCommand) => void) | undefined;
  onRefsChange: () =>
    | ((
        planRefs: PlanReference[],
        workRefs: WorkReference[],
        sessionRefs: SessionReference[],
      ) => void)
    | undefined;
  session: WorkspaceContext;
  pullRequests: PrsStore;
  planStore: PlanStore;
  getEditor: () => AutocompleteEditor | null;
}

export function shouldUnwrapFileReferenceOnBackspace(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
  hasActiveFileCompletion: boolean,
): boolean {
  return (
    event.key === "Backspace" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    !hasActiveFileCompletion
  );
}

export function shouldReleaseSpacedAutocompleteQuery(
  query: string,
  rows: readonly MenuRow[],
): boolean {
  return (
    /\s/.test(query) &&
    !rows.some((row) => row.type === "item" || row.type === "category")
  );
}

/** Mouse hover sets selection, but not for this long after a navigation key —
 *  a stationary cursor must not steal the highlight during keyboard use. */
const HOVER_SUPPRESSION_MS = 400;
export class UnifiedAutocompleteController {
  /** Index of the live trigger character within the text before the caret.
   *  Held across keystrokes so a query can keep its spaces. */
  #anchor = $state<number | null>(null);
  #textBeforeCursor = $state("");
  /** Esc closes the popover but keeps the text; the next keystroke reopens it. */
  #dismissed = $state(false);
  #selectedIndex = $state(0);
  cursorAnchorRect = $state<DOMRect | null>(null);

  #fileResults = $state<FileMatch[]>([]);
  #fileTotal = $state<number | null>(null);
  #fileSearchTimer: ReturnType<typeof setTimeout> | null = null;
  #fileSearchId = 0;

  /** Anchor the `#` indexes were last warmed for. Loading is a rising-edge
   *  event, not a per-keystroke one: an emptiness test would re-fire forever in
   *  a repo that genuinely has no pull requests. */
  #warmedForAnchor: number | null = null;
  #lastKeyAt = 0;
  #pointer: { x: number; y: number } | null = null;

  constructor(private deps: AutocompleteDeps) {
    // Built here rather than as a field initializer: `deps` is a parameter
    // property, which TypeScript assigns after field initializers run.
    this.#index = new ReferenceIndex({
      session: deps.session,
      pullRequests: deps.pullRequests,
      planStore: deps.planStore,
      workingDirectory: () => deps.workingDirectory(),
      tabId: () => deps.tabId(),
    });
  }

  // ─── Commands (`/`) ───

  #pluginCommandNames = $derived.by(
    () =>
      new Set(
        [
          ...this.deps.pluginCommands().global,
          ...this.deps.pluginCommands().project,
        ].map((p) => p.name),
      ),
  );
  #claudeCodeCommands = $derived.by((): SlashCommand[] =>
    this.deps.provider() !== "claude-code"
      ? []
      : (this.deps.pluginCommands().builtin ?? [])
          .filter((c) => !this.#pluginCommandNames.has(c.name))
          .map((c) => ({
            command: `/${c.name}`,
            description: c.argumentHint
              ? `${c.description} [${c.argumentHint}]`
              : c.description,
          })),
  );

  commands = $derived.by(
    (): CategorizedSlashCommands => ({
      solus: this.deps.includeSolusCommands() ? SLASH_COMMANDS : [],
      codex: codexSlashCommands(
        this.deps.provider(),
        this.deps.includeSolusCommands(),
      ),
      claudeCode: this.#claudeCodeCommands,
      global: this.deps.pluginCommands().global.map((p) => ({
        command: `/${p.name}`,
        description: p.argumentHint
          ? `${p.description} [${p.argumentHint}]`
          : p.description,
      })),
      project: this.deps.pluginCommands().project.map((p) => ({
        command: `/${p.name}`,
        description: p.argumentHint
          ? `${p.description} [${p.argumentHint}]`
          : p.description,
      })),
    }),
  );

  /** The `/` channel is flat and ranked: a handful of verbs needs no taxonomy.
   *  The description carries the row; the name is mono because you can type it. */
  #commandItems = $derived.by((): MenuItem[] =>
    [
      ...this.commands.solus,
      ...this.commands.codex,
      ...this.commands.claudeCode,
      ...this.commands.global,
      ...this.commands.project,
    ].map((command) => ({
      id: `cmd:${command.command}`,
      // The leading `/` is the trigger the user already typed, so the row shows
      // the bare name — which is also what the query is matched against.
      title: command.command.slice(1),
      meta: command.description,
      when: "",
      icon: GLYPH.cmd,
      mono: true,
      monoMeta: false,
      token: { kind: "slash", command: command.command },
      command,
    })),
  );

  // ─── Files (`@`) ───

  #openFileItems = $derived.by((): MenuItem[] => {
    const touched = autocompleteSessionChangedFiles(
      this.deps.session.sessions,
      this.deps.sessionId?.(),
    );
    return touched.slice(0, 8).map((path) => this.#fileItem(path, false));
  });

  #worktreeFileItems = $derived.by((): MenuItem[] => {
    const open = new Set(this.#openFileItems.map((item) => item.token.kind === "file" ? item.token.path : ""));
    return this.#fileResults
      .map((file) => {
        const path = this.deps.useRelativeFilePaths() ? file.display : file.path;
        return this.#fileItem(
          file.isDir ? `${path}/` : path,
          file.isDir,
          file.isDir ? file.path : undefined,
        );
      })
      .filter((item) => !open.has(item.token.kind === "file" ? item.token.path : ""));
  });

  #fileItem(path: string, isDir: boolean, directoryPath?: string): MenuItem {
    const trimmed = path.replace(/\/$/, "");
    const cut = trimmed.lastIndexOf("/");
    const name = trimmed.slice(cut + 1);
    return {
      id: `file:${path}`,
      title: isDir ? `${name}/` : name,
      meta: trimmed.slice(0, cut + 1),
      when: "",
      icon: isDir ? GLYPH.folder : GLYPH.file,
      mono: true,
      monoMeta: true,
      token: { kind: "file", path, name },
      directoryPath,
    };
  }

  // ─── Everything else (`#`) ───

  #index: ReferenceIndex;

  /** A getter, not a `$derived` field: `#index` is built in the constructor,
   *  and field initializers run before it exists. The index's own `byKind` is
   *  already derived, so reactivity is unaffected. */
  get #byKind(): Record<RefKind, MenuItem[]> {
    return this.#index.byKind;
  }

  // ─── Derived menu ───

  trigger = $derived.by((): Trigger | null => {
    const trigger = readTrigger(this.#textBeforeCursor, this.#anchor);
    if (!trigger) return null;
    if (trigger.char === "/" && this.deps.enableSlash?.() === false)
      return null;
    return trigger;
  });

  rows = $derived.by((): MenuRow[] => {
    const trigger = this.trigger;
    if (!trigger || this.deps.readOnly()) return [];
    return buildRows({
      trigger,
      commands: this.#commandItems,
      openFiles: this.#openFileItems,
      worktreeFiles: this.#worktreeFileItems,
      worktreeFileCount: this.#fileTotal,
      byKind: this.#byKind,
      linked: this.#index.linkedItems,
      linkedLabel: this.#index.linkedTaskRef,
      counts: {
        plan: this.#byKind.plan.length,
        doc: this.#byKind.doc.length,
        pr: this.#byKind.pr.length,
        session: this.#byKind.session.length,
        task: this.#byKind.task.length,
        automation: this.#byKind.automation.length,
      },
    });
  });

  selectableRows = $derived(this.rows.filter(isSelectable));

  selectedRow = $derived.by((): SelectableRow | null => {
    const rows = this.selectableRows;
    if (rows.length === 0) return null;
    return rows[Math.min(this.#selectedIndex, rows.length - 1)];
  });

  selectedIndex = $derived(
    Math.min(this.#selectedIndex, Math.max(0, this.selectableRows.length - 1)),
  );

  open = $derived(
    this.trigger !== null && !this.#dismissed && this.rows.length > 0,
  );

  ghost = $derived(ghostFor(this.selectedRow, this.trigger?.query ?? ""));

  sessionPreview = $derived(
    this.trigger ? sessionPreviewFor(this.trigger, this.selectedRow) : "",
  );

  /** Footer verbs, so the popover always states what the two keys will do. */
  enterVerb = $derived(
    this.selectedRow?.type === "category"
      ? "open"
      : this.selectedRow?.type === "deadEnd"
        ? "dismiss"
        : "insert",
  );
  tabVerb = $derived(
    this.selectedRow?.type === "category"
      ? "open"
      : this.selectedRow?.type === "item" && this.selectedRow.item.directoryPath
        ? "open"
      : this.selectedRow?.type === "deadEnd"
        ? "dismiss"
        : "complete",
  );
  showTabHint = $derived(this.selectedRow !== null);

  footer = $derived.by(() => {
    const trigger = this.trigger;
    if (!trigger) return "";
    if (trigger.char === "/")
      return `${this.selectableRows.length} commands`;
    if (trigger.char === "@")
      return this.#fileTotal === null
        ? ""
        : `${this.#fileTotal.toLocaleString("en-US")} files`;
    const total = KINDS.reduce(
      (sum, kind) => sum + this.#byKind[kind.key].length,
      0,
    );
    return `${total.toLocaleString("en-US")} referenceable`;
  });

  // ─── Editor change handling ───

  updateCursorAnchor() {
    this.cursorAnchorRect = this.deps.getEditor()?.cursorRect() ?? null;
  }

  clearCompletions() {
    this.#anchor = null;
    this.#dismissed = false;
    this.#selectedIndex = 0;
    this.#fileResults = [];
    this.#fileSearchId++;
    if (this.#fileSearchTimer) {
      clearTimeout(this.#fileSearchTimer);
      this.#fileSearchTimer = null;
    }
  }

  /** Re-evaluate the caret-local trigger and reconcile refs when nodes changed. */
  handleEditorChange(textBeforeCursor: string, trackedRefsChanged = false) {
    this.#textBeforeCursor = textBeforeCursor;

    // The held anchor survives only while it still points at its trigger
    // character; otherwise look for a freshly typed one at the caret.
    let anchor = this.#anchor;
    if (
      anchor === null ||
      anchor >= textBeforeCursor.length ||
      !"/@#.~".includes(textBeforeCursor.charAt(anchor))
    ) {
      anchor = findAnchor(textBeforeCursor);
      if (anchor !== this.#anchor) this.#selectedIndex = 0;
    } else if (!readTrigger(textBeforeCursor, anchor)) {
      // A space closes a `#` run. Re-match at the caret so a later trigger in
      // the same line can open without waiting for the old `#` to be deleted.
      anchor = findAnchor(textBeforeCursor);
      if (anchor !== this.#anchor) this.#selectedIndex = 0;
    }
    this.#anchor = anchor;
    this.#dismissed = false;

    if (trackedRefsChanged) this.syncRefs();
    const trigger = this.trigger;
    if (!trigger) {
      this.#fileResults = [];
      this.#warmedForAnchor = null;
      return;
    }

    // A spaced query that matches nothing hands the words back to the sentence.
    if (shouldReleaseSpacedAutocompleteQuery(trigger.query, this.rows)) {
      this.#anchor = null;
      this.#warmedForAnchor = null;
      return;
    }

    if (trigger.char === "@") this.#searchFiles(trigger.query);
    if (trigger.char === "#" && this.#warmedForAnchor !== trigger.anchor) {
      this.#warmedForAnchor = trigger.anchor;
      this.#loadReferenceIndexes();
    }
    this.updateCursorAnchor();
  }

  #searchFiles(query: string) {
    const searchId = ++this.#fileSearchId;
    // Search immediately on the trigger keystroke so the menu appears without a
    // debounce delay; debounce only while the user keeps typing. Previous
    // results stay visible in between so the menu doesn't flicker closed.
    const isOpening = this.#fileResults.length === 0;
    if (this.#fileSearchTimer) clearTimeout(this.#fileSearchTimer);
    this.#fileSearchTimer = setTimeout(
      async () => {
        const workingDirectory = this.deps.workingDirectory();
        if (!workingDirectory) {
          this.#fileResults = [];
          this.#fileTotal = 0;
          this.#fileSearchTimer = null;
          return;
        }
        const serverId = this.deps.serverId?.();
        const api = serverId
          ? serverConnections.apiFor(serverId)
          : this.deps.session.apiFor(this.deps.tabId());
        const result = await api.searchFiles(
          query,
          workingDirectory,
        );
        if (searchId !== this.#fileSearchId) return;
        this.#fileResults = result.files;
        this.#fileTotal = result.files.length;
        // Results arrive ranked best-first — snap selection back to the top so
        // ⏎ always accepts the best match.
        this.#selectedIndex = 0;
        this.#fileSearchTimer = null;
      },
      isOpening ? 0 : 80,
    );
  }

  /** One key, one index: opening `#` warms all six categories concurrently,
   *  because any of them is reachable by typing three letters without drilling
   *  first. */
  #loadReferenceIndexes() {
    this.#index.warm();
  }

  syncRefs() {
    const onRefsChange = this.deps.onRefsChange();
    if (!onRefsChange) return;
    const editor = this.deps.getEditor();
    if (!editor) return;
    const { planRefs, workRefs, sessionRefs } =
      editor.extractTrackedReferences();
    onRefsChange(planRefs, workRefs, sessionRefs);
  }

  // ─── Actions (arrow fields so row callbacks keep `this`) ───

  /** Rewrite the trigger run to `#<slug>/`, putting the scope in the text where
   *  the caret can keep typing straight into it. */
  drill = (kind: RefKind) => {
    const trigger = this.trigger;
    if (!trigger) return;
    const editor = this.deps.getEditor();
    editor?.replaceTrigger(
      triggerRunPattern(this.#textBeforeCursor, trigger.anchor),
      `#${kindFor(kind).slug}/`,
    );
    this.#selectedIndex = 0;
    editor?.focus();
  };

  /** Leave the scope in one press, dropping the whole slug. */
  leaveScope = () => {
    const trigger = this.trigger;
    if (!trigger) return;
    const editor = this.deps.getEditor();
    editor?.replaceTrigger(
      triggerRunPattern(this.#textBeforeCursor, trigger.anchor),
      trigger.char,
    );
    this.#selectedIndex = 0;
    editor?.focus();
  };

  accept = (item: MenuItem) => {
    if (this.deps.readOnly()) return;
    const trigger = this.trigger;
    if (!trigger) return;

    // A Solus built-in is a whole intent, not a reference: the host runs it.
    if (item.command && SLASH_COMMANDS.includes(item.command)) {
      this.clearCompletions();
      this.deps.onSolusCommand()?.(item.command);
      return;
    }

    const pattern = triggerRunPattern(this.#textBeforeCursor, trigger.anchor);
    const editor = this.deps.getEditor();
    editor?.insertReference(item.token, pattern);
    this.#afterAccept(item);
    this.clearCompletions();
    editor?.focus();
  };

  /** Warm what the chip will need to resolve at render and at send. */
  #afterAccept(item: MenuItem) {
    const { token } = item;
    if (token.kind === "plan") {
      const descriptor = this.deps.planStore.cachedDescriptors.find(
        (d) => planKey(d.sessionId, d.planToolUseId) === token.planId,
      );
      if (descriptor)
        void this.deps.planStore.loadFromDisk({
          serverId: descriptor.serverId,
          sessionId: descriptor.sessionId,
          planToolUseId: descriptor.planToolUseId,
          projectPath: descriptor.projectPath,
          cwd: descriptor.cwd,
          timestamp: descriptor.timestamp,
          filePath: descriptor.planFilePath,
          title: descriptor.title,
          status: descriptor.status,
          bookmarked: descriptor.bookmarked,
          bookmarkedAt: descriptor.bookmarkedAt,
          ctx: this.deps.session.ctx,
          provider: descriptor.provider,
        });
    } else if (token.kind === "work") {
      void this.deps.session.worksStore.ensureContent(
        token.workId,
        "composer-work-select",
        this.deps.workingDirectory(),
      );
    }
    if (token.kind === "plan" || token.kind === "work" || token.kind === "session")
      this.syncRefs();
  }

  /** Run the selected row's action — the one entry point ⏎ and a click share. */
  activate = (row: SelectableRow) => {
    if (row.type === "category") this.drill(row.kind);
    else if (row.type === "item") this.accept(row.item);
    else if (row.action === "back") this.leaveScope();
    else this.clearCompletions();
  };

  acceptGhost = () => {
    const ghost = this.ghost;
    if (!ghost) return;
    const trigger = this.trigger;
    if (!trigger) return;
    const editor = this.deps.getEditor();
    editor?.replaceTrigger(
      triggerRunPattern(this.#textBeforeCursor, trigger.anchor),
      this.#textBeforeCursor.slice(trigger.anchor) + ghost,
    );
    this.#selectedIndex = 0;
    editor?.focus();
  };

  /** Directory browsing stays text-backed just like the former file menu: the
   * absolute path is written into the trigger, so Backspace can walk it back. */
  drillFileDirectory = (item: MenuItem) => {
    const trigger = this.trigger;
    if (!trigger || !item.directoryPath || this.deps.readOnly()) return;
    const editor = this.deps.getEditor();
    editor?.replaceTrigger(
      triggerRunPattern(this.#textBeforeCursor, trigger.anchor),
      `@${item.directoryPath.replace(/\/+$/, "")}/`,
    );
    this.#selectedIndex = 0;
    editor?.focus();
  };

  /** Hover selects, except right after a navigation key. */
  hoverRow = (index: number, event: MouseEvent) => {
    if (Date.now() - this.#lastKeyAt < HOVER_SUPPRESSION_MS) return;
    const { clientX: x, clientY: y } = event;
    if (this.#pointer?.x === x && this.#pointer?.y === y) return;
    this.#pointer = { x, y };
    this.#selectedIndex = index;
  };

  // ─── Keyboard contract ───

  /** Backspace against a file chip restores the `@path` text it was picked
   *  from rather than deleting it, so a mis-picked deep path stays editable. */
  #handleFileRefBackspace(e: KeyboardEvent): boolean {
    // While an @path trigger is being edited it is also parseable as a file
    // reference. Do not mistake that live autocomplete text for an accepted
    // file chip, or Backspace will only reveal the already-visible text and
    // swallow the deletion.
    if (
      !shouldUnwrapFileReferenceOnBackspace(e, this.trigger?.char === "@")
    )
      return false;
    if (this.deps.readOnly()) return false;
    const editor = this.deps.getEditor();
    if (!editor?.unwrapFileReferenceBeforeCursor()) return false;
    e.preventDefault();
    return true;
  }

  /** Returns true when the menu consumed the key (caller should not handle it). */
  handleKeyDown(e: KeyboardEvent): boolean {
    const trigger = this.trigger;

    // One ⌫ on an empty scoped query returns to the six categories, with the
    // query that led there gone — before any chip handling, because the scope is
    // text, not a chip.
    if (
      e.key === "Backspace" &&
      trigger &&
      trigger.path.length > 0 &&
      !trigger.query
    ) {
      e.preventDefault();
      this.leaveScope();
      return true;
    }
    if (this.#handleFileRefBackspace(e)) return true;
    if (!this.open) return false;

    const rows = this.selectableRows;
    const selectedRow = this.selectedRow;
    const selectionAction = autocompleteSelectionAction(
      e.key,
      selectedRow?.type === "item" && !!selectedRow.item.directoryPath,
    );
    if (selectionAction) {
      e.preventDefault();
      this.#lastKeyAt = Date.now();
      if (selectedRow?.type === "item" && selectionAction === "drill")
        this.drillFileDirectory(selectedRow.item);
      else if (selectedRow)
        this.activate(selectedRow);
      return true;
    }

    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        this.#lastKeyAt = Date.now();
        const step = e.key === "ArrowDown" ? 1 : rows.length - 1;
        this.#selectedIndex = (this.selectedIndex + step) % rows.length;
        return true;
      }
      case "ArrowRight": {
        const row = this.selectedRow;
        const atEnd = this.#caretAtLineEnd(e);
        // → is only honoured at the end of the line, so it is never hijacked
        // mid-text. Tab accepts the selected row outright in the case above.
        if (row?.type === "category" && atEnd) {
          e.preventDefault();
          this.#lastKeyAt = Date.now();
          this.drill(row.kind);
          return true;
        }
        if (this.ghost && atEnd) {
          e.preventDefault();
          this.#lastKeyAt = Date.now();
          this.acceptGhost();
          return true;
        }
        return false;
      }
      case "ArrowLeft":
        if (trigger && trigger.path.length > 0 && !trigger.query) {
          e.preventDefault();
          this.leaveScope();
          return true;
        }
        return false;
      case "Escape":
        e.preventDefault();
        this.#dismissed = true;
        return true;
      default:
        return false;
    }
  }

  #caretAtLineEnd(e: KeyboardEvent): boolean {
    const target = e.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
      return target.selectionStart === target.value.length;
    return this.deps.getEditor()?.isCaretAtLineEnd() ?? true;
  }
}
