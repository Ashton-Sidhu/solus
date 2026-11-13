<script lang="ts">
  import { untrack } from "svelte";
  import { getWorkspaceContext, serversStore } from "../../../contexts";
  import { highlightWordRuns, type TextRun } from "../../../lib/searchHighlight";
  import { folderLabel, relativeTime as automationRelativeTime, triggerSummary } from "../../automations/lib/automation-format";
  import { scheduleCardState } from "../../automations/lib/schedule-card";
  import GithubMarkdown from "../../github-markdown/GithubMarkdown.svelte";
  import { PR_ADDITIONS_TONE, PR_DELETIONS_TONE } from "../../prs/lib/pr-row-styles";
  import { prStatusBadge } from "../../prs/lib/pr-utils";
  import { relativeTime } from "../../tasks/lib/tasks-api";
  import LabelChip from "../../ui/labels/LabelChip.svelte";
  import { Skeleton } from "../../ui/skeleton";
  import { rowStatus } from "../../workspace/lib/workspace-items";
  import { recordTimestamp, recordTitle, type PickerRecord } from "./lib/picker-records";
  import { previewBody, workKindLabel, workPreviewBody } from "./lib/picker-record-view";
  import PickerRecordIcon from "./PickerRecordIcon.svelte";

  /**
   * The selected record in miniature: a work's opening, a pull request's
   * description, an automation's schedule and instructions, or a project's
   * home. It reads; it never edits. The action bar under it opens the record.
   */
  interface Props {
    record: PickerRecord;
    /** The search's live query. A row only shows a passage; the title here marks the words too. */
    query?: string;
  }
  let { record, query = "" }: Props = $props();

  const session = getWorkspaceContext();

  // A work's body is read once the row is selected. Until it lands the
  // listing's own snippet stands in, so the pane never opens empty.
  let loadedWork = $state<{ id: string; content: string } | null>(null);
  let failedWorkId = $state<string | null>(null);
  const workId = $derived(record.type === "work" ? record.item.id : null);
  $effect(() => {
    const id = workId;
    if (!id || untrack(() => loadedWork?.id) === id) return;
    void session.worksStore
      .ensureContent(id, "search-preview")
      .then((work) => {
        if (work) loadedWork = { id, content: work.content };
        else failedWorkId = id;
      })
      .catch(() => (failedWorkId = id));
  });
  const workContent = $derived(
    record.type === "work" && loadedWork?.id === record.item.id ? loadedWork.content : null,
  );

  const updatedAt = $derived(recordTimestamp(record));
  // The machine a record is on. A host this client does not list has no name
  // to show, so the pane says nothing of it.
  const automationHost = $derived(
    record.type === "automation" ? serversStore.hostFor(session.automationsStore.hostFor(record.automation.id)) : null,
  );
  const projectHost = $derived(record.type === "project" ? serversStore.hostFor(record.project.serverId) : null);
</script>

{#snippet marked(runs: TextRun[])}
  {#each runs as run, i (i)}{#if run.hit}<mark
        class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)] px-px text-inherit"
        >{run.text}</mark
      >{:else}{run.text}{/if}{/each}
{/snippet}

{#snippet separator()}
  <span class="opacity-[0.32]" aria-hidden="true">/</span>
{/snippet}

{#snippet sectionHeading(label: string)}
  <div class="mb-1.5 flex items-center gap-2.5">
    <span class="text-micro font-medium tracking-[0.13em] text-muted-foreground uppercase">{label}</span>
    <span class="h-px flex-1 bg-[var(--hairline)]" aria-hidden="true"></span>
  </div>
{/snippet}

{#snippet fact(label: string, value: string)}
  <div class="flex min-w-0 items-baseline gap-3 border-b-[0.5px] border-[var(--hairline)] py-1.5 text-workspace-chrome last:border-b-0">
    <span class="w-24 shrink-0 text-muted-foreground">{label}</span>
    <span class="min-w-0 flex-1 truncate text-foreground" title={value}>{value}</span>
  </div>
{/snippet}

<div class="flex min-w-0 flex-col" data-testid="picker-record-preview" data-record-type={record.type}>
  {#if record.type === "work"}
    {@const item = record.item}
    {@const status = rowStatus(item)}
    <div class="mb-3 flex flex-wrap items-center gap-2.5 text-micro text-muted-foreground">
      <span class="inline-flex items-center gap-1.5"><PickerRecordIcon {record} size={12} />{workKindLabel(item)}</span>
      {@render separator()}
      <span class="truncate" title={item.cwd}>{item.projectLabel}</span>
      {@render separator()}
      <span>updated {relativeTime(item.timestamp)}</span>
      {#if status}
        {@render separator()}
        <span>{status.label}</span>
      {/if}
    </div>
    <h3 class="mb-2.5 text-[1.1875rem] leading-[1.3] font-semibold tracking-[-0.014em] text-pretty text-foreground">{@render marked(highlightWordRuns(item.title, query))}</h3>
    {#if item.type === "doc" && workContent !== null}
      <div class="prose min-w-0"><GithubMarkdown source={workPreviewBody(item.title, workContent)} policy="local" /></div>
    {:else if item.type === "doc" && failedWorkId !== item.id}
      <!-- The snippet first, so the pane has words while the body is read. -->
      {#if item.snippet}<p class="mb-4 text-workspace-chrome leading-[1.7] text-pretty text-muted-foreground">{item.snippet}</p>{/if}
      <div class="flex flex-col gap-2" aria-hidden="true">
        <Skeleton class="h-3 w-[82%] rounded-[0.375rem]" />
        <Skeleton class="h-3 w-[68%] rounded-[0.375rem]" />
        <Skeleton class="h-3 w-[74%] rounded-[0.375rem]" />
      </div>
    {:else if item.snippet}
      <!-- An artifact or an app is a page that runs. The preview does not run
           it: it shows the words the listing holds. -->
      <p class="whitespace-pre-wrap text-workspace-chrome leading-[1.7] text-pretty text-muted-foreground">{@render marked(highlightWordRuns(item.snippet, query))}</p>
    {:else}
      <p class="text-workspace-chrome leading-[1.7] text-muted-foreground opacity-70">No preview text.</p>
    {/if}
  {:else if record.type === "pullRequest"}
    {@const pullRequest = record.found.pullRequest}
    {@const badge = prStatusBadge(pullRequest)}
    <div class="mb-3 flex flex-wrap items-center gap-2.5 text-micro text-muted-foreground">
      {#if badge}
        {@const BadgeIcon = badge.Icon}
        <span class="inline-flex items-center gap-1.5" style="color: {badge.tone}"><BadgeIcon size={12} />{badge.label}</span>
        {@render separator()}
      {/if}
      <span>#{pullRequest.number}</span>
      {@render separator()}
      <span class="truncate">{pullRequest.baseRepo.owner}/{pullRequest.baseRepo.repo}</span>
      {@render separator()}
      <span>{pullRequest.author}</span>
      {#if updatedAt}
        {@render separator()}
        <span>updated {relativeTime(updatedAt)}</span>
      {/if}
    </div>
    <h3 class="mb-2.5 text-[1.1875rem] leading-[1.3] font-semibold tracking-[-0.014em] text-pretty text-foreground">{@render marked(highlightWordRuns(pullRequest.title, query))}</h3>
    <div class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-micro text-muted-foreground">
      <span class="min-w-0 truncate font-mono" title="{pullRequest.headRef} into {pullRequest.baseRef}">{pullRequest.headRef} → {pullRequest.baseRef}</span>
      <span class="shrink-0 font-mono tabular-nums"><span class={PR_ADDITIONS_TONE}>+{pullRequest.additions}</span> <span class={PR_DELETIONS_TONE}>−{pullRequest.deletions}</span></span>
      {#if pullRequest.changedFiles !== null}
        <span class="shrink-0 tabular-nums">{pullRequest.changedFiles} {pullRequest.changedFiles === 1 ? "file" : "files"}</span>
      {/if}
      {#each pullRequest.labels as label (label.name)}
        <LabelChip label={label.name} color={label.color} />
      {/each}
    </div>
    {#if pullRequest.body.trim()}
      <div class="prose min-w-0"><GithubMarkdown source={previewBody(pullRequest.body)} lineBreaks /></div>
    {:else}
      <p class="text-workspace-chrome leading-[1.7] text-muted-foreground opacity-70">No description.</p>
    {/if}
  {:else if record.type === "automation"}
    {@const automation = record.automation}
    <div class="mb-3 flex flex-wrap items-center gap-2.5 text-micro text-muted-foreground">
      <span class="inline-flex items-center gap-1.5"><PickerRecordIcon {record} size={12} />Automation</span>
      {@render separator()}
      <span>{triggerSummary(automation.trigger)}</span>
      {@render separator()}
      <span class="truncate" title={automation.action.cwd}>{folderLabel(automation.action.cwd)}</span>
    </div>
    <h3 class="mb-2.5 text-[1.1875rem] leading-[1.3] font-semibold tracking-[-0.014em] text-pretty text-foreground">{@render marked(highlightWordRuns(recordTitle(record), query))}</h3>
    <div class="mb-5 flex flex-col">
      {@render fact("Schedule", scheduleCardState(automation))}
      {#if automation.lastRunAt}
        {@render fact("Last check", `${automation.lastRunStatus ?? "ran"} · ${automationRelativeTime(automation.lastRunAt)}`)}
      {/if}
      {#if automationHost}{@render fact("Host", automationHost.label)}{/if}
    </div>
    {@render sectionHeading("Instructions")}
    <p class="whitespace-pre-wrap text-workspace-chrome leading-[1.7] text-pretty text-muted-foreground">{@render marked(highlightWordRuns(previewBody(automation.action.prompt), query))}</p>
  {:else if record.type === "project"}
    {@const project = record.project}
    <div class="mb-3 flex flex-wrap items-center gap-2.5 text-micro text-muted-foreground">
      <span class="inline-flex items-center gap-1.5"><PickerRecordIcon {record} size={12} />Project</span>
      {#if project.localOnly}
        {@render separator()}
        <span>no git remote</span>
      {/if}
    </div>
    <h3 class="mb-2.5 text-[1.1875rem] leading-[1.3] font-semibold tracking-[-0.014em] text-pretty text-foreground">{@render marked(highlightWordRuns(project.label, query))}</h3>
    <div class="flex flex-col">
      {@render fact("Folder", project.projectKey)}
      {#if projectHost}{@render fact("Host", projectHost.label)}{/if}
      {#if !project.available}
        {@render fact("State", project.unavailableNote ?? "its host is not connected")}
      {/if}
    </div>
  {:else}
    <div class="flex items-center gap-2.5 text-workspace-chrome text-muted-foreground">
      <PickerRecordIcon {record} size={14} />
      <span class="text-foreground">{record.action.label}</span>
      {#if record.action.hint}<span class="font-mono text-micro">{record.action.hint}</span>{/if}
    </div>
  {/if}
</div>
