const SAVE_DEBOUNCE_MS = 600;

interface SaveOptions {
  /** The content to write at the moment the save runs. */
  content: () => string;
  save: (content: string) => Promise<void>;
  /** True while there are edits the host has not accepted yet. */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * Save status of one open diagram, mirroring DocumentShell: a debounce-armed
 * pending flag and an in-flight flag read as "Saving…", then the last-saved
 * time. It knows nothing about diagram content, only when to write it.
 */
export class DiagramSaver {
  isSaving = $state(false);
  hasPendingSave = $state(false);
  saveFailed = $state(false);
  // Why the last save failed — a stale cloud copy, a read-only mirror and a
  // dropped connection all need a different reaction from the reader.
  saveError = $state<string | null>(null);
  lastSavedAt = $state<number | null>(null);
  readonly showSaving = $derived(this.hasPendingSave || this.isSaving);

  private readonly options: SaveOptions;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;

  constructor(options: SaveOptions) {
    this.options = options;
  }

  schedule() {
    clearTimeout(this.timeout);
    this.hasPendingSave = true;
    this.options.onDirtyChange?.(true);
    this.timeout = setTimeout(() => void this.perform(), SAVE_DEBOUNCE_MS);
  }

  retry() {
    clearTimeout(this.timeout);
    void this.perform();
  }

  /** Write a pending edit now, so one made just before teardown still lands. */
  flush() {
    if (!this.hasPendingSave) return;
    clearTimeout(this.timeout);
    void this.perform();
  }

  private async perform() {
    const revision = ++this.revision;
    const content = this.options.content();
    this.hasPendingSave = false;
    this.isSaving = true;
    try {
      await this.options.save(content);
      if (revision !== this.revision) return;
      this.saveFailed = false;
      this.saveError = null;
      this.lastSavedAt = Date.now();
      if (!this.hasPendingSave) this.options.onDirtyChange?.(false);
    } catch (error) {
      // Stay dirty: clearing it would let the host treat unsaved edits as
      // clean, and an agent refresh clobber them.
      if (revision === this.revision) {
        this.saveFailed = true;
        this.saveError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (revision === this.revision) this.isSaving = false;
    }
  }
}
