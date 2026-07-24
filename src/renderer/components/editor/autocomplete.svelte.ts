// Reference-autocomplete state machine, decoupled from any editor host.
//
// It owns the six completion channels — slash commands, @-files, #plans,
// %works, !PRs and &sessions — including their filter state, candidate fetching, keyboard handling
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
  SessionMeta,
  SessionReference,
  Work,
  WorkReference,
} from "../../../shared/types";
import type { PullRequestSummary } from "../../../shared/providers";
import type { PlanRefAttrs } from "./planRefExtension";
import type { PrRefAttrs } from "./prRefExtension";
import type { WorkRefAttrs } from "./workRefExtension";
import type { SessionRefAttrs } from "./sessionRefExtension";
import {
  SLASH_COMMANDS,
  getFilteredFromCategorized,
  type SlashCommand,
  type CategorizedSlashCommands,
} from "../input/slash-commands";
import { type WorkspaceContext, type PlanStore } from "../../contexts";
import * as refs from "./references";

// Trigger patterns shared by every reference-aware composer. Re-exported by
// PromptEditor so callers don't re-declare them.
export const SLASH_INLINE_RE = /(?:^|\s)(\/[a-zA-Z-]*)$/;
export const FILE_TRIGGER_RE =
  /(?:(?<![^\s])@([^\s]*)|(~\/[^\s]*|\.\.?\/[^\s]*))$/;
export const PLAN_TRIGGER_RE = /(?:^|\s)#([^\s]*)$/;
export const WORK_TRIGGER_RE = /(?:^|\s)%([^\s]*)$/;
export const PR_TRIGGER_RE = /(?:^|\s)!([^\s]*)$/;
export const SESSION_TRIGGER_RE = /(?:^|\s)&([^\s]*)$/;

/** A referenced session's chip label: its slug, else the first line of its
 *  first message, else a short id. */
function sessionRefTitle(session: SessionMeta): string {
  const slug = session.slug?.trim();
  if (slug) return slug;
  const firstLine = session.firstMessage?.split("\n")[0]?.trim();
  if (firstLine) return firstLine;
  return session.sessionId.slice(0, 8);
}

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
    | ((
        planRefs: PlanReference[],
        workRefs: WorkReference[],
        sessionRefs: SessionReference[],
      ) => void)
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

  // ─── Pull request autocomplete ───
  prFilter = $state<string | null>(null);
  prIndex = $state(0);
  prCandidates = $state<PullRequestSummary[]>([]);
  prMenuLoading = $state(false);
  #prLoadRequestId = 0;

  // ─── Session autocomplete ───
  sessionFilter = $state<string | null>(null);
  sessionIndex = $state(0);
  sessionCandidates = $state<SessionMeta[]>([]);
  sessionMenuLoading = $state(false);
  #sessionLoadRequestId = 0;

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

  prResults = $derived.by(() => {
    if (this.prFilter === null) return [] as PullRequestSummary[];
    const query = this.prFilter.trim().toLowerCase().replace(/^#/, "");
    return (
      query
        ? this.prCandidates.filter(
            (pullRequest) =>
              String(pullRequest.number).includes(query) ||
              pullRequest.title.toLowerCase().includes(query) ||
              pullRequest.author.toLowerCase().includes(query),
          )
        : this.prCandidates
    ).slice(0, 20);
  });

  sessionResults = $derived.by(() => {
    if (this.sessionFilter === null) return [] as SessionMeta[];
    const query = this.sessionFilter.trim().toLowerCase();
    // You can't reference your own conversation (matches prompt_session).
    const currentSessionId = this.deps.session.activeSession?.agentSessionId;
    const all = this.sessionCandidates.filter(
      (session) => session.sessionId !== currentSessionId,
    );
    return (
      query
        ? all.filter(
            (session) =>
              (session.slug ?? "").toLowerCase().includes(query) ||
              (session.firstMessage ?? "").toLowerCase().includes(query) ||
              session.cwd.toLowerCase().includes(query),
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
  isPrMenuLoading = $derived.by(
    () =>
      this.prFilter !== null &&
      this.prMenuLoading &&
      this.prResults.length === 0,
  );
  showPrMenu = $derived.by(
    () =>
      this.prFilter !== null &&
      (this.prResults.length > 0 || this.isPrMenuLoading),
  );
  isSessionMenuLoading = $derived.by(
    () =>
      this.sessionFilter !== null &&
      this.sessionMenuLoading &&
      this.sessionResults.length === 0,
  );
  showSessionMenu = $derived.by(
    () =>
      this.sessionFilter !== null &&
      (this.sessionResults.length > 0 || this.isSessionMenuLoading),
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
    this.prFilter = null;
    this.sessionFilter = null;
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
      const descriptorKey = workingDirectory
        ? planStore.descriptorCacheKey(workingDirectory, false)
        : null;
      if (
        descriptorKey !== null &&
        (planStore.cachedDescriptorKey !== descriptorKey ||
          planStore.cachedDescriptors.length === 0) &&
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

  #updatePrFilter(textBeforeCursor: string) {
    const match = textBeforeCursor.match(PR_TRIGGER_RE);
    if (match) {
      const isOpening = this.prFilter === null;
      this.prFilter = match[1] ?? "";
      this.prIndex = 0;
      if (isOpening) void this.#loadPullRequestsForMenu();
    } else {
      this.prFilter = null;
    }
  }

  async #loadPullRequestsForMenu() {
    const requestId = ++this.#prLoadRequestId;
    this.prMenuLoading = true;
    try {
      const workingDirectory = this.deps.workingDirectory();
      const context = workingDirectory
        ? this.deps.session.ctxForDirectory(workingDirectory)
        : this.deps.session.ctx;
      const result = await this.deps.session.prsStore.loadFor(
        context,
        { state: "open" },
      );
      if (requestId === this.#prLoadRequestId) {
        this.prCandidates = [...result.items].sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
      }
    } finally {
      if (requestId === this.#prLoadRequestId) this.prMenuLoading = false;
    }
  }

  #updateSessionFilter(textBeforeCursor: string) {
    const match = textBeforeCursor.match(SESSION_TRIGGER_RE);
    if (match) {
      const isOpening = this.sessionFilter === null;
      this.sessionFilter = match[1] ?? "";
      this.sessionIndex = 0;
      if (isOpening) void this.#loadSessionsForMenu();
    } else {
      this.sessionFilter = null;
    }
  }

  async #loadSessionsForMenu() {
    const requestId = ++this.#sessionLoadRequestId;
    this.sessionMenuLoading = true;
    try {
      const workingDirectory = this.deps.workingDirectory();
      // listSessions returns [] without a project path, so a session-less
      // composer has nothing to offer — bail before the IPC round-trip.
      if (!workingDirectory) return;
      const sessions = await window.solus.listSessions(
        workingDirectory,
        this.deps.session.ctxForDirectory(workingDirectory),
      );
      if (requestId === this.#sessionLoadRequestId) {
        this.sessionCandidates = [...sessions].sort(
          (a, b) =>
            new Date(b.lastTimestamp).getTime() -
            new Date(a.lastTimestamp).getTime(),
        );
      }
    } finally {
      if (requestId === this.#sessionLoadRequestId)
        this.sessionMenuLoading = false;
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

  handlePrSelect = (pullRequest: PullRequestSummary) => {
    if (this.deps.readOnly()) return;
    const attrs: PrRefAttrs = {
      number: pullRequest.number,
      title: pullRequest.title,
    };
    refs.insertPrReference(this.deps.getEditor(), attrs, PR_TRIGGER_RE);
    this.clearCompletions();
    this.deps.focusEditor();
  };

  handleSessionSelect = (session: SessionMeta) => {
    if (this.deps.readOnly()) return;
    const attrs: SessionRefAttrs = {
      sessionId: session.sessionId,
      provider: session.provider,
      title: sessionRefTitle(session),
      cwd: session.cwd,
    };
    refs.insertSessionReference(
      this.deps.getEditor(),
      attrs,
      SESSION_TRIGGER_RE,
    );
    this.syncRefs();
    this.clearCompletions();
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
    const onRefsChange = this.deps.onRefsChange();
    if (!onRefsChange) return;
    const { planRefs, workRefs, sessionRefs } = refs.extractRefs(
      this.deps.getEditor(),
    );
    onRefsChange(planRefs, workRefs, sessionRefs);
  }

  // ─── Core handlers ───

  /** Backspace against a file chip restores the `@path` text it was picked
   *  from rather than deleting it, so a mis-picked deep path stays editable.
   *  Restoring the text re-matches FILE_TRIGGER_RE on the next editor update,
   *  which reopens the menu at that path. */
  #handleFileRefBackspace(e: KeyboardEvent): boolean {
    if (e.key !== "Backspace") return false;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
    if (this.deps.readOnly()) return false;
    const editor = this.deps.getEditor();
    const selection = editor?.state.selection;
    if (!selection?.empty) return false;
    const nodeBefore = selection.$from.nodeBefore;
    if (nodeBefore?.type.name !== "fileReference") return false;
    e.preventDefault();
    refs.unwrapFileReference(editor, selection.from - nodeBefore.nodeSize);
    return true;
  }

  /** Returns true when a menu consumed the key (caller should not handle it). */
  handleKeyDown(e: KeyboardEvent): boolean {
    if (this.#handleFileRefBackspace(e)) return true;
    if (this.showWorkMenu && this.#handleWorkMenuKey(e)) return true;
    if (
      this.showSessionMenu &&
      this.#handleMenuKey(
        e,
        this.sessionIndex,
        this.sessionResults.length,
        (n) => (this.sessionIndex = n),
        () => this.handleSessionSelect(this.sessionResults[this.sessionIndex]),
        () => {
          this.sessionFilter = null;
        },
      )
    )
      return true;
    if (
      this.showPrMenu &&
      this.#handleMenuKey(
        e,
        this.prIndex,
        this.prResults.length,
        (n) => (this.prIndex = n),
        () => this.handlePrSelect(this.prResults[this.prIndex]),
        () => {
          this.prFilter = null;
        },
      )
    )
      return true;
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

  /** Re-evaluate caret-local triggers and reconcile refs only when their nodes changed. */
  handleEditorChange(textBeforeCursor: string, trackedRefsChanged = false) {
    this.updateSlashFilter(textBeforeCursor);
    this.#updateFileFilter(textBeforeCursor);
    this.#updatePlanFilter(textBeforeCursor);
    this.#updateWorkFilter(textBeforeCursor);
    this.#updatePrFilter(textBeforeCursor);
    this.#updateSessionFilter(textBeforeCursor);
    if (trackedRefsChanged) this.syncRefs();
    if (
      this.slashFilter !== null ||
      this.fileFilter !== null ||
      this.planFilter !== null ||
      this.workFilter !== null ||
      this.prFilter !== null ||
      this.sessionFilter !== null
    ) {
      this.updateCursorAnchor();
    }
  }
}
