<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { SvelteSet } from "svelte/reactivity";
  import {
    AppWindow as AppWindowIcon,
    Check as CheckIcon,
    CircleAlert as CircleAlertIcon,
    FileText as FileTextIcon,
    Image as ImageIcon,
    List as ListIcon,
    Presentation as PresentationIcon,
    Workflow as WorkflowIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import type { Message, Plan, WorkMeta } from "@solus/contracts/types";
  import { markdownSanitizeUrl } from "../../../lib/markdownSanitize";
  import { assistantMarkdownOptions, assistantMarkdownExtensions } from "../../conversation/lib/assistant-markdown";
  import { noticeText } from "../../conversation/lib/transient";
  import UserMessageBubble from "../../conversation/UserMessageBubble.svelte";
  import ToolGroupItem from "../../conversation/ToolGroupItem.svelte";
  import ThoughtRow from "../../conversation/ThoughtRow.svelte";
  import AnsweredQuestion from "../../conversation/AnsweredQuestion.svelte";
  import TranscriptCard from "../../conversation/TranscriptCard.svelte";
  import TranscriptDivider from "../../conversation/TranscriptDivider.svelte";
  import { compactionDividerText } from "../../conversation/lib/compaction-divider";
  import TurnEndDivider from "../../conversation/TurnEndDivider.svelte";
  import FencedBlock from "../../conversation/FencedBlock.svelte";
  import MarkdownLink from "../../conversation/MarkdownLink.svelte";
  import CodeSpan from "../../ui/CodeSpan.svelte";
  import TranscriptTable from "../../conversation/TranscriptTable.svelte";
  import AssistantAlert from "../../conversation/AssistantAlert.svelte";
  import FootnoteRef from "../../conversation/FootnoteRef.svelte";
  import FootnoteSection from "../../conversation/FootnoteSection.svelte";
  import ArtifactView from "../../artifact/ArtifactView.svelte";
  import { planTypeLabel } from "../../plan/lib/plan-type-label";
  import {
    ALERT_TOKEN,
    FOOTNOTE_REF_TOKEN,
    FOOTNOTE_SECTION_TOKEN,
  } from "../../conversation/lib/markdown-extensions";
  import { artifactIsReadable, recordDocuments, recordRows } from "./lib/record-transcript";

  /**
   * One page of a transcript with no tab behind it: the cloud's copy of a
   * session, read by its runner's people when the runner is away and by a
   * share-link guest. It draws what the transcript carries — prompts, prose,
   * answered questions, tool activity, plans, artifacts, documents, and how
   * each turn ended — and nothing that acts: no pane opens, no plan is
   * decided. A document the reader cannot read is named, and says so.
   */
  let {
    messages,
    serverId,
    planFor,
    workFor,
    openWork,
  }: {
    messages: Message[];
    serverId: string;
    planFor: (planId: string) => Plan | undefined;
    workFor: (workId: string) => Pick<WorkMeta, "title" | "type"> | undefined;
    /** Absent where there is no workspace to open a work in. */
    openWork?: (workId: string) => void;
  } = $props();

  const rows = $derived(recordRows(messages));
  const expandedPlanIds = new SvelteSet<string>();
  const NOT_SHARED = "Not shared with you";
  const markdownRenderers = {
    code: FencedBlock,
    codespan: CodeSpan,
    link: MarkdownLink,
    table: TranscriptTable,
    [ALERT_TOKEN]: AssistantAlert,
    [FOOTNOTE_REF_TOKEN]: FootnoteRef,
    [FOOTNOTE_SECTION_TOKEN]: FootnoteSection,
  };

  function togglePlan(planId: string) {
    if (expandedPlanIds.has(planId)) expandedPlanIds.delete(planId);
    else expandedPlanIds.add(planId);
  }
</script>

{#snippet markdown(source: string)}
  <SvelteMarkdown
    {source}
    options={assistantMarkdownOptions}
    renderers={markdownRenderers}
    extensions={assistantMarkdownExtensions(source)}
    sanitizeUrl={markdownSanitizeUrl}
  />
{/snippet}

<!-- The work is not part of the session's share; the card names it and says so. -->
{#snippet notShared()}<p class="text-(--solus-text-tertiary)" data-testid="record-not-shared">{NOT_SHARED}</p>{/snippet}

<div class="flex flex-col">
  {#each rows as row (row.key)}
    {#if row.kind === "end"}
      {#if row.end.kind === "failed"}
        {#snippet failedDetail()}
          <p class="font-mono text-[0.875em] whitespace-pre-wrap break-words text-(--solus-text-secondary)">{row.end.detail}</p>
        {/snippet}
        <TranscriptCard
          title={row.end.cause || "The run failed"}
          type="failed"
          failed
          glyphClass="is-failed"
          body={row.end.detail && row.end.detail !== row.end.cause ? failedDetail : undefined}
          data-testid="record-turn-failed"
          skipMotion
        >
          {#snippet glyph()}<CircleAlertIcon />{/snippet}
        </TranscriptCard>
      {:else}
        <TurnEndDivider end={row.end} {serverId} skipMotion />
      {/if}
    {:else}
      {@const item = row.item}
      {#if item.kind === "user"}
        <UserMessageBubble message={item.message} skipMotion />
      {:else if item.kind === "assistant"}
        {#if item.message.content}
          <div class="prose-cloud prose-reading prose-transcript prose-transcript-main response-markdown min-w-0 py-2" data-testid="assistant-message">
            {@render markdown(item.message.content)}
          </div>
        {/if}
      {:else if item.kind === "thought"}
        <ThoughtRow message={item.message} skipMotion />
      {:else if item.kind === "question"}
        <AnsweredQuestion message={item.message} />
      {:else if item.kind === "tool-group"}
        <ToolGroupItem tools={item.messages} steps={item.steps} skipMotion />
      {:else if item.kind === "subagent-group"}
        <ToolGroupItem tools={item.messages} skipMotion />
      {:else if item.kind === "system" && item.message.compaction}
        {@const compaction = compactionDividerText(item.message.compaction)}
        <TranscriptDivider timestamp={item.message.timestamp} skipMotion>{compaction.label}{#if compaction.detail}{` · ${compaction.detail}`}{/if}</TranscriptDivider>
      {:else if item.kind === "system"}
        <TranscriptDivider timestamp={item.message.timestamp} skipMotion>{noticeText(item.message.content)}</TranscriptDivider>
      {:else if item.kind === "plan"}
        {@const plan = item.message.planId ? planFor(item.message.planId) : undefined}
        {@const status = plan?.status ?? "pending"}
        <!-- A plan is read here, never decided: the card discloses its text. -->
        <TranscriptCard
          title={plan?.title ?? "Plan"}
          type={planTypeLabel(status)}
          expanded={plan ? expandedPlanIds.has(plan.id) : undefined}
          ariaLabel={plan ? `Show plan: ${plan.title}` : undefined}
          onOpen={plan ? () => togglePlan(plan.id) : undefined}
          glyphClass={status === "accepted" ? "is-done" : ""}
          data-testid="record-plan-card"
          skipMotion
        >
          {#snippet glyph()}
            {#if status === "accepted"}<CheckIcon />{:else if status === "rejected"}<XIcon />{:else}<ListIcon />{/if}
          {/snippet}
          {#snippet body()}
            {#if plan?.content}
              <div class="prose-cloud prose-reading prose-transcript response-markdown min-w-0">{@render markdown(plan.content)}</div>
            {/if}
          {/snippet}
        </TranscriptCard>
      {:else if item.kind === "document"}
        {#each recordDocuments(item.messages, workFor) as document (document.workId)}
          <TranscriptCard
            title={document.title}
            type={document.workType === "insights-report" ? "report" : document.workType}
            actionLabel={document.isReadable && openWork ? "Open" : undefined}
            ariaLabel={`Open document: ${document.title}`}
            onOpen={document.isReadable && openWork ? () => openWork(document.workId) : undefined}
            glyphClass={document.workType === "artifact" ? "is-artifact" : ""}
            body={document.isReadable ? undefined : notShared}
            data-testid="record-document-card"
            skipMotion
          >
            {#snippet glyph()}
              {#if document.workType === "slides"}<PresentationIcon />{:else if document.workType === "diagram"}<WorkflowIcon />{:else if document.workType === "artifact"}<AppWindowIcon />{:else}<FileTextIcon />{/if}
            {/snippet}
            {#snippet rail()}{#if document.contentVersion}v{document.contentVersion}{/if}{/snippet}
          </TranscriptCard>
        {/each}
      {:else if item.kind === "artifact" && item.message.artifact}
        {@const artifact = item.message.artifact}
        {#if artifactIsReadable(artifact)}
          <!-- No work reference: its rail shares, links, and opens a pane. -->
          <ArtifactView {artifact} skipMotion />
          {#if item.message.workRef?.title}
            <p class="truncate px-1 pb-1 text-[0.875em] text-(--solus-text-tertiary)">Artifact · {item.message.workRef.title}</p>
          {/if}
        {:else}
          <TranscriptCard
            title={item.message.workRef?.title ?? artifact.path?.split("/").pop() ?? "Artifact"}
            type={artifact.kind === "image" ? "image" : "artifact"}
            glyphClass="is-artifact"
            body={notShared}
            data-testid="record-artifact-unavailable"
            skipMotion
          >
            {#snippet glyph()}{#if artifact.kind === "image"}<ImageIcon />{:else}<AppWindowIcon />{/if}{/snippet}
          </TranscriptCard>
        {/if}
      {/if}
    {/if}
  {/each}
</div>
