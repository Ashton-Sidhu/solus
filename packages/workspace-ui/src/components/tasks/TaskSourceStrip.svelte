<script lang="ts">
  import { Layers as LayersIcon, TriangleAlert as WarningIcon, X as XIcon } from "@lucide/svelte";
  import { taskSourceProvider } from "@solus/contracts/task-sources";
  import { getClientShellContext, getSettingsContext, taskSourcesStore } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { SourceLogo } from "../ui/list-page";
  import TaskSourceAdd from "./sources/TaskSourceAdd.svelte";
  import { saveTaskSources } from "./sources/lib/save-task-sources.svelte";
  import { sourceHealthNote, sourceStripRows, withoutTaskSource, type SourceStripRow } from "./sources/lib/task-source-setup";

  /**
   * The person's task sources, and the one place to see and change them
   * (docs/tasks.md). Each chip is a source with how many tasks it holds; one
   * pick plots that source with the provider's own columns, and All plots
   * every source together, grouped by status category
   * (docs/plans/provider-owned-tasks.md §7). A source that cannot be read
   * shows a warning that is its repair; the × removes a source, with Undo.
   * The last chip adds a source. There is no default source: a new task goes
   * where its work says (`inferTaskSourceKey`).
   */
  interface Props {
    /** The source on screen. Null = all sources. */
    sourceKey: string | null;
    counts: Map<string, number>;
    allCount: number;
    onSelect: (sourceKey: string | null) => void;
    /** Called after the sources change, so the page reads its tasks again. */
    onChanged: () => void;
  }
  let { sourceKey, counts, allCount, onSelect, onChanged }: Props = $props();

  const settings = getSettingsContext();
  const shell = getClientShellContext();

  const config = $derived({ taskSources: settings.taskSources });
  const rows = $derived(sourceStripRows(config, taskSourcesStore.sources));
  function save(patch: Parameters<typeof saveTaskSources>[1]): boolean {
    const isSaved = saveTaskSources(settings, patch);
    if (isSaved) onChanged();
    return isSaved;
  }

  // No confirm: the tasks stay on the provider, and Undo puts the source back
  // where it was.
  function remove(row: SourceStripRow) {
    const before = $state.snapshot(config.taskSources);
    if (!save(withoutTaskSource(config, row.sourceKey))) return;
    toasts.undo(`Removed ${row.label}`, () => save({ taskSources: before }));
  }

  // The repair the warning stands for: the connection, or a new read.
  function repair(row: SourceStripRow) {
    const health = row.state?.health;
    if (health === "not_connected" || health === "reconnect") openConnections();
    else void taskSourcesStore.load({ refresh: "force" });
  }

  // The repair of a connection: the connections page of the host that reads the sources.
  function openConnections() {
    const serverId = taskSourcesStore.host;
    if (serverId) shell.openResource({ kind: "connections", serverId });
  }
</script>

<div class="flex min-w-0 items-center gap-1">
  <!-- The chips scroll sideways when they do not fit; the add chip stays. The
       inset keeps a focus ring inside the scroll box, which clips. -->
  <div
    class="-m-0.5 flex min-w-0 items-center gap-1 overflow-x-auto p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:h-0"
    role="group"
    aria-label="Task sources"
  >
    {#if rows.length > 1}
      <button
        type="button"
        aria-pressed={sourceKey === null}
        title="Every source, grouped by status category"
        onclick={() => onSelect(null)}
        class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg border-0 px-2.5 text-workspace-chrome transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-9 {sourceKey === null
          ? 'bg-[var(--wash-3)] text-foreground'
          : 'bg-transparent text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground'}"
      >
        <LayersIcon size={16} class="shrink-0 opacity-75" aria-hidden="true" />
        <span>All</span>
        <span class="shrink-0 text-xs tabular-nums opacity-70">{allCount}</span>
      </button>
    {/if}
    {#each rows as row (row.sourceKey)}
      <!-- One source is the whole page: it shows selected, and All is not offered. -->
      {@const selected = rows.length === 1 || row.sourceKey === sourceKey}
      {@const health = row.state?.health ?? "ok"}
      {@const note = row.state ? sourceHealthNote(row.state) : null}
      <div
        class="group/chip flex max-w-72 min-w-0 shrink-0 items-center rounded-lg transition-colors duration-150 {selected
          ? 'bg-[var(--wash-3)] text-foreground'
          : 'text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground'}"
      >
        <button
          type="button"
          aria-pressed={selected}
          title={row.label}
          onclick={() => onSelect(rows.length === 1 ? null : row.sourceKey)}
          class="flex h-7 min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg border-0 bg-transparent pr-1 pl-2.5 text-workspace-chrome text-inherit focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-9"
        >
          <SourceLogo source={taskSourceProvider(row.source)} />
          <span class="truncate">{row.label}</span>
          {#if row.state && health === "ok"}
            <span class="shrink-0 text-xs tabular-nums opacity-70">{counts.get(row.sourceKey) ?? 0}</span>
          {/if}
        </button>
        {#if note && health !== "ok"}
          <!-- The warning is the repair: Reconnect, or read again. -->
          <button
            type="button"
            class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--warning) hover:bg-[var(--wash-3)] focus-visible:outline-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:size-9"
            title="{note.label}: {note.message} {health === 'not_connected' || health === 'reconnect' ? 'Click to connect.' : 'Click to read again.'}"
            aria-label="{note.label}, {row.label}. {health === 'not_connected' || health === 'reconnect' ? 'Connect' : 'Read again'}"
            onclick={() => repair(row)}
          >
            <WarningIcon size={13} aria-hidden="true" />
          </button>
        {/if}
        <!-- Quiet until the chip is pointed at or focused; the space stays, so
             a chip never shifts on hover. -->
        <button
          type="button"
          class="mr-0.5 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-inherit opacity-0 transition-opacity duration-100 group-focus-within/chip:opacity-60 group-hover/chip:opacity-60 hover:opacity-100! focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:size-9 pointer-coarse:opacity-60"
          title="Remove {row.label}. The tasks stay on {taskSourceProvider(row.source) === 'github' ? 'GitHub' : 'Jira'}."
          aria-label="Remove {row.label}"
          onclick={() => remove(row)}
        >
          <XIcon size={12} aria-hidden="true" />
        </button>
      </div>
    {/each}
  </div>
  <TaskSourceAdd look="strip" {onChanged} />
</div>
