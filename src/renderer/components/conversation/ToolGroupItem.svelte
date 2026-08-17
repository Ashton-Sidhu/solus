<script lang="ts">
  import { WarningCircleIcon } from "phosphor-svelte";
  import { prettyToolName } from "../../contexts/workspace/session.utils";
  import { requestInputFocus } from "../../lib/inputFocus";
  import ActivityRow from "./ActivityRow.svelte";
  import { KIND_ICONS } from "./lib/activity-icons";
  import {
    activityDurationMs,
    activityKind,
    activityKinds,
    activitySummary,
    formatActivityDuration,
    getToolDescription,
    getToolDescriptionFromParsed,
    liveActivityLabel,
    parseToolInput,
    participleFor,
    type ParsedToolInput,
  } from "./lib/activity-summary";
  import { waitingOnLabel } from "./agent-conversation/lib/agent-conversation";
  import type { Message, TurnStartKind } from "../../../shared/types";

  interface Props {
    tools: Message[];
    skipMotion?: boolean;
    /** This group is the tail of a turn the session is still working on, so the
     *  run is happening right here — even between two tool calls. */
    working?: boolean;
    /** Session lifecycle label shown between tool calls while this row owns the spinner. */
    activityLabel?: string;
    turnStart?: TurnStartKind | null;
    /** Agents this turn has asked and not yet heard back from. A parent that is
     *  blocked on another agent is not planning anything — it is waiting, and
     *  the row should say whose reply it is waiting for. */
    waitingOn?: string[];
  }
  let {
    tools,
    skipMotion = false,
    working = false,
    activityLabel,
    turnStart = null,
    waitingOn = [],
  }: Props = $props();

  let expanded = $state(false);
  let expandedToolId = $state<string | null>(null);

  const runningTool = $derived(tools.find((t) => t.toolStatus === "running"));
  // A failure only owns the row while it is the last thing that happened. Once
  // the run has moved past it the group goes back to its summary — otherwise one
  // early error stays stuck on a group that has since done a dozen fine things.
  const failedTool = $derived.by(() => {
    const last = tools[tools.length - 1];
    if (!last) return undefined;
    return last.toolStatus === "error" ? last : undefined;
  });

  const parseCache = new WeakMap<Message, ParsedToolInput | null>();

  // A running tool's toolInput is empty/absent — the full input lands only at
  // completion. Parsing (and caching) it while running would pin a stale null, so
  // skip until it's done, then parse each tool at most once, cached on the message.
  const parsedInputs = $derived(
    tools.map((tool) => {
      if (!tool.toolInput || tool.toolStatus === "running") return null;
      const cached = parseCache.get(tool);
      if (cached !== undefined) return cached;
      const parsed = parseToolInput(tool.toolInput);
      parseCache.set(tool, parsed);
      return parsed;
    }),
  );

  const kinds = $derived(activityKinds(tools));
  const summary = $derived(activitySummary(tools));
  const durationMs = $derived(activityDurationMs(tools));
  const duration = $derived(durationMs === null ? "" : formatActivityDuration(durationMs));

  // While running, the sentence names what is happening now, not the whole group.
  const runningLabel = $derived(
    runningTool ? participleFor(runningTool.toolName) : "",
  );
  // Running and failed both name the tool they are talking about; a finished
  // group names none, because the summary already counts them.
  const namedTool = $derived(runningTool ?? failedTool);
  const namedTarget = $derived.by(() => {
    if (!namedTool) return "";
    const raw = getToolDescription(namedTool.toolName || "Tool", namedTool.toolInput);
    // The participle already carries the verb, so drop the description's own.
    return raw.replace(/^(Read|Edit|Write|Search files|Search|Fetch)[:\s]+/i, "").trim();
  });
  const doneCount = $derived(tools.filter((t) => t.toolStatus !== "running").length);

  const failureLine = $derived.by(() => {
    if (!failedTool) return "";
    const text = (failedTool.errorHead || "").trim();
    const first = text.split("\n").map((line) => line.trim()).find(Boolean);
    return first ? (first.length > 240 ? `${first.slice(0, 237)}…` : first) : "";
  });

  function describe(tool: Message, parsed: ParsedToolInput | null): string {
    const toolName = tool.toolName || "Tool";
    if (tool.toolStatus === "running") return prettyToolName(toolName);
    return parsed
      ? getToolDescriptionFromParsed(toolName, parsed, { truncate: false })
      : getToolDescription(toolName, tool.toolInput, { truncate: false });
  }

  function toggleExpanded(): void {
    expanded = !expanded;
    requestInputFocus();
  }

  function toggleToolExpanded(toolId: string): void {
    expandedToolId = expandedToolId === toolId ? null : toolId;
  }
</script>

{#snippet targetText()}{namedTarget}{/snippet}

<!-- No chassis at all: no fill, no hairline, no tint. This is the least
     important thing in the turn — it says how the answer was produced — so once
     it has finished it should read as a caption.

     §16 — one row, whatever the group is doing. The spinner, the icon cluster
     and the failure glyph all take the same 22px slot and the chevron holds its
     position, so the row rewrites itself in place instead of jumping when the
     group lands. -->
<!-- `activity-host` opts this row out of the transcript's paint containment,
     which would otherwise clip the row's rounded chassis flat. -->
<div class="activity-host {skipMotion ? '' : 'animate-msg-in-side'}">
  <ActivityRow
    {expanded}
    onToggle={toggleExpanded}
    target={namedTarget ? targetText : undefined}
    glyphClass={failedTool && !runningTool ? "is-destructive" : ""}
    testid={runningTool
      ? "activity-running"
      : failedTool
        ? "activity-failed"
        : "activity-summary"}
  >
    {#snippet glyph()}
      {#if runningTool || (working && !failedTool)}
        <span class="activity-spinner" aria-hidden="true"></span>
      {:else if failedTool}
        <WarningCircleIcon size={13} />
      {:else}
        {#each kinds as kind (kind)}
          {@const Glyph = KIND_ICONS[kind]}
          <Glyph size={11} />
        {/each}
      {/if}
    {/snippet}

    {#snippet label()}
      {#if runningTool}
        <span class="activity-shimmer">{runningLabel}</span>
      {:else if working && !failedTool}
        <span class="activity-shimmer">
          {waitingOnLabel(waitingOn) ?? liveActivityLabel(activityLabel, 0, true, turnStart)}
        </span>
      {:else if failedTool}
        <span class="tool-named">{prettyToolName(failedTool.toolName || "Tool")} failed</span>
      {:else}
        {#each summary as segment, i (i)}
          {#if segment.strong}<span class="tool-named">{segment.text}</span
            >{:else}{segment.text}{/if}
        {/each}
      {/if}
    {/snippet}

    {#snippet rail()}
      {#if runningTool && tools.length > 1}
        <span>{doneCount}/{tools.length}</span>
      {/if}
      <span class="activity-rail-time">{duration}</span>
    {/snippet}

    <!-- Behind the chevron, on the same indented rule the step list uses: the
         error is diagnostic detail, not transcript content, and a failure is not
         more important than the answer above it. -->
    {#snippet detail()}
      {#if failureLine}
        <div class="tool-stderr font-mono">{failureLine}</div>
      {/if}
      {#each tools as tool, i (tool.id)}
        {@const parsed = parsedInputs[i]}
        {@const Glyph = KIND_ICONS[activityKind(tool.toolName)]}
        {@const failed = tool.toolStatus === "error"}
        <div class:tool-step--expanded={expandedToolId === tool.id} class="tool-step">
          <span class:tool-step-glyph--failed={failed} class="tool-step-glyph">
            {#if failed}
              <WarningCircleIcon size={13} />
            {:else}
              <Glyph size={11} />
            {/if}
          </span>
          <button
            type="button"
            class:is-expanded={expandedToolId === tool.id}
            class="tool-step-text font-mono"
            aria-expanded={expandedToolId === tool.id}
            onclick={() => toggleToolExpanded(tool.id)}
          >
            {describe(tool, parsed)}
          </button>
          <span class="flex-1"></span>
          {#if tool.toolCompletedAt}
            <span class="tool-step-duration font-mono shrink-0">
              {formatActivityDuration(tool.toolCompletedAt - tool.timestamp)}
            </span>
          {/if}
        </div>
      {/each}
    {/snippet}
  </ActivityRow>
</div>

<style>
  /* The tool a running or failed row names, and the one number in a finished
     row's sentence — the parts worth scanning. */
  .tool-named {
    color: var(--solus-text-primary);
  }

  .tool-stderr {
    padding: 0.125rem 0 0.3125rem;
    font-size: 0.75rem;
    line-height: 1.65;
    color: var(--muted-foreground);
    white-space: pre-wrap;
  }

  .tool-step {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.25rem 0;
  }

  .tool-step--expanded {
    align-items: flex-start;
  }

  .tool-step-glyph {
    display: inline-flex;
    width: 1.375rem;
    height: 1.125rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    color: var(--muted-foreground);
    opacity: 0.5;
  }

  .tool-step-glyph--failed {
    color: var(--destructive);
    opacity: 1;
  }

  .tool-step-text {
    min-width: 0;
    overflow: hidden;
    border: 0;
    background: transparent;
    padding: 0;
    color: inherit;
    white-space: nowrap;
    text-align: left;
    text-overflow: ellipsis;
    font-size: 0.75rem;
    opacity: 0.8;
    cursor: pointer;
  }

  .tool-step-text.is-expanded {
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .tool-step-text:focus-visible {
    border-radius: 0.25rem;
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.125rem;
  }

  .tool-step-duration {
    font-size: 0.75rem;
    color: var(--muted-foreground);
    opacity: 0.55;
  }
</style>
