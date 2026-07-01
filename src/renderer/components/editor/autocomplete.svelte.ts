// Reference-autocomplete state machine, decoupled from any editor host.
//
// It owns the four completion channels — slash commands, @-files, #plans and
// %works — including their filter state, candidate fetching, keyboard handling
// and reference insertion. It operates on a Tiptap `Editor` (via the host
// accessors) rather than a specific component, so the same autocomplete can be
// mounted around any editor surface (the prompt input today, the document
// editor later).
import type { Editor } from "@tiptap/core";
import { planKey } from "../../../shared/types";
import type {
  AgentId,
  FileMatch,
  PlanDescriptor,
  PlanReference,
  PluginCommandsResult,
  Work,
  WorkReference,
} from "../../../shared/types";
import type { PlanRefAttrs } from "./planRefExtension";
import type { WorkRefAttrs } from "./workRefExtension";
import {
  SLASH_COMMANDS,
  getFilteredFromCategorized,
  type SlashCommand,
  type CategorizedSlashCommands,
} from "../input/slash-commands";
import type { WorkspaceContext } from "../../contexts/workspace.context.svelte";
import type { PlanStore } from "../../contexts/plan.store.svelte";
import * as refs from "./references";

// Trigger patterns shared by every reference-aware composer. Re-exported by
// PromptEditor so callers don't re-declare them.
export const SLASH_INLINE_RE = /(?:^|\s)(\/[a-zA-Z-]*)$/;
export const FILE_TRIGGER_RE =
  /(?:(?<![^\s])@([^\s]*)|(~\/[^\s]*|\.\.?\/[^\s]*))$/;
export const PLAN_TRIGGER_RE = /(?:^|\s)#([^\s]*)$/;
export const WORK_TRIGGER_RE = /(?:^|\s)%([^\s]*)$/;

/** Imperative handle onto the file menu component (it owns its own selection).
 *  Signatures mirror FileAutocompleteMenu's exports so the instance is directly
 *  assignable. */
export interface FileMenuHandle {
  resetSelection(): void;
  moveSelection(delta: -1 | 1): boolean;
  getSelected(): FileMatch | null;
  acceptSelection(): boolean;
}

/** Everything the controller needs from its host. Reactive props are passed as
 *  getters so reads stay reactive across the module boundary. */
export interface AutocompleteDeps {
  readOnly: () => boolean;
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
    | ((planRefs: PlanReference[], workRefs: WorkReference[]) => void)
    | undefined;
  session: WorkspaceContext;
  planStore: PlanStore;
  getEditor: () => Editor | null;
  focusEditor: () => void;
  getCursorRect: () => DOMRect | null;
  getFileMenu: () => FileMenuHandle | null;
}

function moveIndex(current: number, delta: number, count: number) {
  return count === 0 ? 0 : (current + delta + count) % count;
}

export class AutocompleteController {
  // ─── Slash command menu ───
  slashFilter = $state<string | null>(null);
  slashIndex = $state(0);
  cursorAnchorRect = $state<DOMRect | null>(null);

  // ─── File autocomplete ───
  fileFilter = $state<string | null>(null);
  fileResults = $state<FileMatch[]>([]);
  #fileSearchTimer: ReturnType<typeof setTimeout> | null = null;
  #fileSearchId = 0;

  // ─── Plan autocomplete ───
  planFilter = $state<string | null>(null);
  planIndex = $state(0);

  // ─── Work autocomplete ───
  workFilter = $state<string | null>(null);
  workIndex = $state(0);
  workMenuLoading = $state(false);
  workMenuUsesInlineTrigger = $state(false);
  #workLoadRequestId = 0;

  constructor(private deps: AutocompleteDeps) {}

  // Built-in Claude Code commands come live from the SDK, de-duped against the
  // filesystem plugin/skill commands shown in their own buckets.
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

  filteredSlashCommands = $derived.by(() =>
    this.slashFilter
      ? getFilteredFromCategorized(this.slashFilter, this.commands)
      : [],
  );

  planResults = $derived.by(() => {
    if (this.planFilter === null) return [] as PlanDescriptor[];
    const query = this.planFilter.toLowerCase();
    const all = [...this.deps.planStore.cachedDescriptors].sort(
      (a, b) => b.timestamp - a.timestamp,
    );
    return (
      query ? all.filter((d) => d.title.toLowerCase().includes(query)) : all
    ).slice(0, 20);
  });

  workResults = $derived.by(() => {
    if (this.workFilter === null) return [] as Work[];
    const query = this.workFilter.trim().toLowerCase();
    const all = Object.values(this.deps.session.worksStore.works).sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    return (
      query
        ? all.filter(
            (w) =>
              w.title.toLowerCase().includes(query) ||
              w.preview.toLowerCase().includes(query) ||
              w.type.toLowerCase().includes(query),
          )
        : all
    ).slice(0, 20);
  });

  // ─── Menu visibility ───
  showSlashMenu = $derived.by(
    () => this.slashFilter !== null && !this.deps.readOnly(),
  );
  showFileMenu = $derived.by(
    () => this.fileFilter !== null && this.fileResults.length > 0,
  );
  isPlanMenuLoading = $derived.by(
    () =>
      this.planFilter !== null &&
      this.deps.planStore.descriptorCacheLoading &&
      this.planResults.length === 0,
  );
  showPlanMenu = $derived.by(
    () =>
      this.planFilter !== null &&
      (this.planResults.length > 0 || this.isPlanMenuLoading),
  );
  isWorkMenuLoading = $derived.by(
    () =>
      this.workFilter !== null &&
      this.workMenuLoading &&
      this.workResults.length === 0,
  );
  showWorkMenu = $derived.by(
    () =>
      this.workFilter !== null &&
      (this.workResults.length > 0 || this.isWorkMenuLoading),
  );

  // ─── Menu helpers ───

  updateCursorAnchor() {
    this.cursorAnchorRect = this.deps.getCursorRect();
  }

  #clearFileCompletion() {
    this.fileFilter = null;
    this.fileResults = [];
    this.#fileSearchId++;
    if (this.#fileSearchTimer) {
      clearTimeout(this.#fileSearchTimer);
      this.#fileSearchTimer = null;
    }
  }

  clearCompletions() {
    this.slashFilter = null;
    this.planFilter = null;
    this.workFilter = null;
    this.workMenuUsesInlineTrigger = false;
    this.#clearFileCompletion();
  }

  #handleMenuKey(
    e: KeyboardEvent,
    index: number,
    count: number,
    setIndex: (n: number) => void,
    onAccept: () => void,
    onDismiss: () => void,
  ): boolean {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setIndex(moveIndex(index, 1, count));
        return true;
      case "ArrowUp":
        e.preventDefault();
        setIndex(moveIndex(index, -1, count));
        return true;
      case "Tab":
      case "Enter":
        e.preventDefault();
        if (count > 0) onAccept();
        return true;
      case "Escape":
        e.preventDefault();
        onDismiss();
        return true;
      default:
        return false;
    }
  }

  updateSlashFilter(textBeforeCursor: string) {
    if (this.deps.enableSlash?.() === false) {
      this.slashFilter = null;
      return;
    }
    const match = textBeforeCursor.match(SLASH_INLINE_RE);
    if (match) {
      this.slashFilter = match[1];
      this.slashIndex = 0;
    } else {
      this.slashFilter = null;
    }
  }

  #updateFileFilter(value: string) {
    const match = value.match(FILE_TRIGGER_RE);
    if (match) {
      const query = match[1] ?? match[2] ?? "";
      const searchId = ++this.#fileSearchId;
      // Keep previous results visible while the new search is in flight so
      // the menu doesn't flicker closed on every keystroke.
      const isOpening = this.fileFilter === null;
      this.fileFilter = query;
      if (this.#fileSearchTimer) clearTimeout(this.#fileSearchTimer);
      // Search immediately on the trigger keystroke so the menu appears
      // without a debounce delay; debounce only while the user keeps typing.
      this.#fileSearchTimer = setTimeout(
        async () => {
          const result = await window.solus.searchFiles(
            query,
            // searchFiles' main-process handler tolerates an absent cwd; the
            // type says string, so pass through the possibly-undefined value.
            this.deps.workingDirectory() as string,
          );
          if (searchId !== this.#fileSearchId) return;
          this.fileResults = result.files;
          // Results arrive ranked best-first — snap selection back to the top
          // so Enter always accepts the best match.
          this.deps.getFileMenu()?.resetSelection();
          this.#fileSearchTimer = null;
        },
        isOpening ? 0 : 80,
      );
    } else {
      this.#clearFileCompletion();
    }
  }

  #updatePlanFilter(textBeforeCursor: string) {
    const match = textBeforeCursor.match(PLAN_TRIGGER_RE);
    if (match) {
      this.planFilter = match[1] ?? "";
      this.planIndex = 0;
      const planStore = this.deps.planStore;
      const workingDirectory = this.deps.workingDirectory();
      if (
        planStore.cachedDescriptors.length === 0 &&
        !planStore.descriptorCacheLoading &&
        workingDirectory
      ) {
        planStore.preloadDescriptors(workingDirectory, this.deps.session.ctx);
      }
    } else {
      this.planFilter = null;
    }
  }

  #updateWorkFilter(textBeforeCursor: string) {
    const match = textBeforeCursor.match(WORK_TRIGGER_RE);
    if (match) {
      this.workMenuUsesInlineTrigger = true;
      this.workFilter = match[1] ?? "";
      this.workIndex = 0;
      if (
        Object.keys(this.deps.session.worksStore.works).length === 0 &&
        !this.workMenuLoading
      ) {
        void this.#loadWorksForMenu();
      }
    } else {
      this.workFilter = null;
    }
  }

  async #loadWorksForMenu() {
    const requestId = ++this.#workLoadRequestId;
    this.workMenuLoading = true;
    try {
      await this.deps.session.worksStore.loadAll(this.deps.workingDirectory());
    } finally {
      if (requestId === this.#workLoadRequestId) this.workMenuLoading = false;
    }
  }

  #handleWorkMenuKey(e: KeyboardEvent): boolean {
    if (
      this.#handleMenuKey(
        e,
        this.workIndex,
        this.workResults.length,
        (n) => (this.workIndex = n),
        () => {
          const work = this.workResults[this.workIndex];
          if (work) this.handleWorkSelect(work);
        },
        () => {
          this.workFilter = null;
        },
      )
    )
      return true;

    if (this.workMenuUsesInlineTrigger) return false;
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.key === "Backspace") {
      e.preventDefault();
      this.workFilter = (this.workFilter ?? "").slice(0, -1);
      this.workIndex = 0;
      return true;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      this.workFilter = `${this.workFilter ?? ""}${e.key}`;
      this.workIndex = 0;
      return true;
    }
    return false;
  }

  // ─── Menu actions (arrow fields so child onSelect callbacks keep `this`) ───

  handleFileSelect = (file: FileMatch) => {
    if (this.deps.readOnly()) return;
    const refPath = this.deps.useRelativeFilePaths() ? file.display : file.path;
    const name = refPath.slice(refPath.lastIndexOf("/") + 1);
    refs.insertFileReference(
      this.deps.getEditor(),
      { path: file.isDir ? refPath + "/" : refPath, name },
      FILE_TRIGGER_RE,
    );
    this.clearCompletions();
    this.deps.focusEditor();
  };

  handleFileDrillIn = (file: FileMatch) => {
    if (this.deps.readOnly()) return;
    refs.updateTriggerText(this.deps.getEditor(), FILE_TRIGGER_RE, `@${file.path}/`);
    this.deps.focusEditor();
  };

  handlePlanSelect = (descriptor: PlanDescriptor) => {
    if (this.deps.readOnly()) return;
    const id = planKey(descriptor.sessionId, descriptor.planToolUseId);
    const attrs: PlanRefAttrs = {
      planId: id,
      sessionId: descriptor.sessionId,
      planToolUseId: descriptor.planToolUseId,
      title: descriptor.title,
      status: descriptor.status,
    };
    refs.insertPlanReference(this.deps.getEditor(), attrs, PLAN_TRIGGER_RE);
    this.syncRefs();
    this.clearCompletions();
    void this.deps.planStore.loadFromDisk({
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
    this.deps.focusEditor();
  };

  handleWorkSelect = (work: Work) => {
    if (this.deps.readOnly()) return;
    const attrs: WorkRefAttrs = {
      workId: work.id,
      title: work.title,
      type: work.type,
    };
    refs.insertWorkReference(this.deps.getEditor(), attrs, WORK_TRIGGER_RE);
    this.syncRefs();
    this.clearCompletions();
    void this.deps.session.worksStore.ensureContent(
      work.id,
      "composer-work-select",
      this.deps.workingDirectory(),
    );
    this.deps.focusEditor();
  };

  handleSlashSelect = (cmd: SlashCommand) => {
    if (this.deps.readOnly()) return;
    const isSolusBuiltIn = SLASH_COMMANDS.some(
      (c) => c.command === cmd.command,
    );
    if (isSolusBuiltIn) {
      this.clearCompletions();
      this.deps.onSolusCommand()?.(cmd);
      return;
    }
    refs.insertSlashReference(
      this.deps.getEditor(),
      { command: cmd.command },
      SLASH_INLINE_RE,
    );
    this.clearCompletions();
    this.deps.focusEditor();
  };

  syncRefs() {
    this.deps.onRefsChange()?.(
      refs.extractPlanRefs(this.deps.getEditor()),
      refs.extractWorkRefs(this.deps.getEditor()),
    );
  }

  // ─── Core handlers ───

  /** Returns true when a menu consumed the key (caller should not handle it). */
  handleKeyDown(e: KeyboardEvent): boolean {
    if (this.showWorkMenu && this.#handleWorkMenuKey(e)) return true;
    if (
      this.showPlanMenu &&
      this.#handleMenuKey(
        e,
        this.planIndex,
        this.planResults.length,
        (n) => (this.planIndex = n),
        () => this.handlePlanSelect(this.planResults[this.planIndex]),
        () => {
          this.planFilter = null;
        },
      )
    )
      return true;
    if (this.showFileMenu) {
      const fileMenu = this.deps.getFileMenu();
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          fileMenu?.moveSelection(1);
          return true;
        case "ArrowUp":
          e.preventDefault();
          fileMenu?.moveSelection(-1);
          return true;
        case "Tab": {
          e.preventDefault();
          const selected = fileMenu?.getSelected();
          if (selected?.isDir) this.handleFileDrillIn(selected);
          else fileMenu?.acceptSelection();
          return true;
        }
        case "Enter":
          e.preventDefault();
          fileMenu?.acceptSelection();
          return true;
        case "Escape":
          e.preventDefault();
          this.clearCompletions();
          return true;
      }
    }
    if (
      this.showSlashMenu &&
      this.#handleMenuKey(
        e,
        this.slashIndex,
        this.filteredSlashCommands.length,
        (n) => (this.slashIndex = n),
        () => this.handleSlashSelect(this.filteredSlashCommands[this.slashIndex]),
        () => {
          this.slashFilter = null;
        },
      )
    )
      return true;

    return false;
  }

  /** Re-evaluate every trigger from the text before the cursor. */
  handleEditorChange(textBeforeCursor: string) {
    this.updateSlashFilter(textBeforeCursor);
    this.#updateFileFilter(textBeforeCursor);
    this.#updatePlanFilter(textBeforeCursor);
    this.#updateWorkFilter(textBeforeCursor);
    this.syncRefs();
    if (
      this.slashFilter !== null ||
      this.fileFilter !== null ||
      this.planFilter !== null ||
      this.workFilter !== null
    ) {
      this.updateCursorAnchor();
    }
  }
}
