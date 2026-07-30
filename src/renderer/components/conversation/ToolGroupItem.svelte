<script lang="ts">
  import { untrack } from "svelte";
  import { WarningCircleIcon } from "phosphor-svelte";
  import { prettyToolName } from "../../contexts/workspace/session.utils";
  import { requestInputFocus } from "../../lib/inputFocus";
  import ActivityRow from "./ActivityRow.svelte";
  import ToolTraceItem from "./ToolTraceItem.svelte";
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
    participleFor,
  } from "./lib/activity-summary";
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
    /** Transcript mode keeps every observable call available after the run
     * settles, including its exact input and returned output. */
    traceDetails?: boolean;
    initiallyExpanded?: boolean;
  }
  let {
    tools,
    skipMotion = false,
    working = false,
    activityLabel,
    turnStart = null,
    traceDetails = false,
    initiallyExpanded = false,
  }: Props = $props();

  let expanded = $state(untrack(() => initiallyExpanded));

  const runningTool = $derived(tools.find((t) => t.toolStatus === "running"));
  const failedTool = $derived(
    tools.find((t) => t.toolStatus === "error" || t.toolResultIsError),
  );

  const parseCache = new WeakMap<Message, Record<string, unknown> | null>();

  // A running tool's toolInput is empty/absent — the full input lands only at
  // completion. Parsing (and caching) it while running would pin a stale null, so
  // skip until it's done, then parse each tool at most once, cached on the message.
  const parsedInputs = $derived(
    tools.map((tool) => {
      if (!tool.toolInput || tool.toolStatus === "running") return null;
      const cached = parseCache.get(tool);
      if (cached !== undefined) return cached;
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(tool.toolInput) as Record<string, unknown>;
      } catch {}
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
    const text = (failedTool.toolResult || failedTool.content || "").trim();
    const first = text.split("\n").map((line) => line.trim()).find(Boolean);
    return first ? (first.length > 240 ? `${first.slice(0, 237)}…` : first) : "";
  });

  function describe(tool: Message, parsed: Record<string, unknown> | null): string {
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
</script>

{#snippet targetText()}{namedTarget}{/snippet}

<!-- No chassis at all: no fill, no hairline, no tint. This is the least
     important thing in the turn — it says how the answer was produced — so once
     it has finished it should read as a caption.

     §16 — one row, whatever the group is doing. The spinner, the icon cluster
     and the failure glyph all take the same 22px slot and the chevron holds its
     position, so the row rewrites itself in place instead of jumping when the
     group lands. -->
<div class={skipMotion ? "" : "animate-msg-in-side"}>
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
          {liveActivityLabel(activityLabel, 0, true, turnStart)}
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
      {#if failureLine && !traceDetails}
        <div class="tool-stderr font-mono">{failureLine}</div>
      {/if}
      {#if traceDetails}
        <div class="tool-trace-list">
          {#each tools as tool (tool.id)}
            <ToolTraceItem {tool} />
          {/each}
        </div>
      {:else}
        {#each tools as tool, i (tool.id)}
          {@const parsed = parsedInputs[i]}
          {@const Glyph = KIND_ICONS[activityKind(tool.toolName)]}
          <div class="tool-step">
            <span class="tool-step-glyph">
              <Glyph size={11} />
            </span>
            <span class="tool-step-text font-mono truncate">{describe(tool, parsed)}</span>
            <span class="flex-1"></span>
            {#if tool.toolCompletedAt}
              <span class="tool-step-duration font-mono shrink-0">
                {formatActivityDuration(tool.toolCompletedAt - tool.timestamp)}
              </span>
            {/if}
          </div>
        {/each}
      {/if}
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
    font-size: 0.71875rem;
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

  .tool-trace-list {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    margin-left: -0.75rem;
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

  .tool-step-text {
    min-width: 0;
    font-size: 0.71875rem;
    opacity: 0.8;
  }

  .tool-step-duration {
    font-size: 0.65625rem;
    color: var(--muted-foreground);
    opacity: 0.55;
  }
</style>
