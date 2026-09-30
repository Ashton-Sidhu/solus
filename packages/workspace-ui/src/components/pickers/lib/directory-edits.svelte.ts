import type { HostApi } from "@solus/client-core/host-api";
import type { DirectoryEntry } from "@solus/contracts/types";
import { joinBrowsePath, type BrowsePathPlatform } from "./browse-path";

/**
 * The one folder operation the picker is part-way through. `delete` is the
 * permanent step, offered only after the host said it has no Trash.
 */
export type DirectoryEdit =
  | { kind: "create"; name: string }
  | { kind: "rename"; entry: DirectoryEntry; name: string }
  | { kind: "trash"; entry: DirectoryEntry }
  | { kind: "delete"; entry: DirectoryEntry };

export const NEW_FOLDER_NAME = "untitled folder";

/** Why `name` cannot name a folder here, or null when it can. */
export function folderNameProblem(
  name: string,
  siblingNames: readonly string[],
  currentName?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name.";
  if (trimmed === "." || trimmed === "..") return "That name is reserved.";
  if (trimmed.includes("/") || trimmed.includes("\\")) return "A name can’t contain / or \\.";
  if (trimmed !== currentName && siblingNames.includes(trimmed)) {
    return "Something with that name already exists here.";
  }
  return null;
}

interface DirectoryEditsOptions {
  api: () => HostApi;
  /** Host-resolved folder being browsed; new and renamed entries land in it. */
  directory: () => string;
  platform: () => BrowsePathPlatform;
  /** Every name in the folder, files included, so a rename cannot collide. */
  siblingNames: () => readonly string[];
  /** The listing changed. `landedPath` is the entry to highlight, if one remains. */
  onChanged: (landedPath: string | null) => void;
}

/** New folder, rename, and trash for the directory picker. */
export class DirectoryEdits {
  edit = $state<DirectoryEdit | null>(null);
  isBusy = $state(false);
  error = $state<string | null>(null);

  constructor(private readonly options: DirectoryEditsOptions) {}

  get nameProblem(): string | null {
    const edit = this.edit;
    if (edit?.kind === "create") return folderNameProblem(edit.name, this.options.siblingNames());
    if (edit?.kind === "rename") {
      return folderNameProblem(edit.name, this.options.siblingNames(), edit.entry.name);
    }
    return null;
  }

  startCreate(seedName = ""): void {
    this.#start({ kind: "create", name: seedName || NEW_FOLDER_NAME });
  }

  startRename(entry: DirectoryEntry): void {
    this.#start({ kind: "rename", entry, name: entry.name });
  }

  startTrash(entry: DirectoryEntry): void {
    this.#start({ kind: "trash", entry });
  }

  setName(name: string): void {
    if (this.edit?.kind === "create" || this.edit?.kind === "rename") this.edit.name = name;
    this.error = null;
  }

  cancel(): void {
    this.edit = null;
    this.error = null;
  }

  async commit(): Promise<void> {
    const edit = this.edit;
    if (!edit || this.isBusy || this.nameProblem) return;
    this.isBusy = true;
    this.error = null;
    try {
      const outcome = await this.#run(edit);
      if (outcome.error !== null) {
        this.error = outcome.error;
        return;
      }
      // Trash may have handed over to the permanent step; that edit stays open.
      if (this.edit === edit) this.edit = null;
      if (outcome.changed) this.options.onChanged(outcome.landedPath);
    } catch {
      this.error = "Couldn’t reach the host. Check the connection and try again.";
    } finally {
      this.isBusy = false;
    }
  }

  #start(edit: DirectoryEdit): void {
    if (this.isBusy) return;
    this.edit = edit;
    this.error = null;
  }

  async #run(
    edit: DirectoryEdit,
  ): Promise<{ error: string | null; changed: boolean; landedPath: string | null }> {
    const api = this.options.api();
    if (edit.kind === "create") {
      const target = joinBrowsePath(this.options.directory(), edit.name.trim(), this.options.platform());
      const result = await api.createDirectory(target);
      return { error: result.error, changed: !result.error, landedPath: result.path };
    }
    if (edit.kind === "rename") {
      const name = edit.name.trim();
      if (name === edit.entry.name) return { error: null, changed: false, landedPath: null };
      const toPath = joinBrowsePath(this.options.directory(), name, this.options.platform());
      const result = await api.mutateHostPath({ op: "rename", path: edit.entry.path, toPath });
      return result.ok
        ? { error: null, changed: true, landedPath: result.path }
        : { error: result.error, changed: false, landedPath: null };
    }
    const result = await api.mutateHostPath({ op: edit.kind, path: edit.entry.path });
    if (!result.ok && result.trashUnavailable) {
      this.edit = { kind: "delete", entry: edit.entry };
      return { error: null, changed: false, landedPath: null };
    }
    return result.ok
      ? { error: null, changed: true, landedPath: null }
      : { error: result.error, changed: false, landedPath: null };
  }
}
