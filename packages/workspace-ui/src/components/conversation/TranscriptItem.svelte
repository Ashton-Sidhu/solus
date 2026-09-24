<script lang="ts">
  import { modelLabelFor, type Message } from "@solus/contracts/types";
  import { ArrowRight as ArrowRightIcon, Code as CodeIcon, GitFork as GitForkIcon,
    CirclePlus as PlusCircleIcon, GitFork as TreeStructureIcon } from "@lucide/svelte";
  import { getWorkspaceContext, getPlanStore, runtime } from "../../contexts";
  import type { TaskLinkContext } from "../tasks/link-control/lib/task-link-control";
  import type { GroupedItem } from "./lib/turns";
  import ToolGroupItem from "./ToolGroupItem.svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import AnsweredQuestion from "./AnsweredQuestion.svelte";
  import TranscriptDivider from "./TranscriptDivider.svelte";
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import OpenAIBlossom from "../pickers/OpenAIBlossom.svelte";
  import MessageHoverRail from "./MessageHoverRail.svelte";
  import UserMessageBubble from "./UserMessageBubble.svelte";
  import SubagentGroup from "./SubagentGroup.svelte";
  import PlanMessageItem from "../plan/PlanMessageItem.svelte";
  import DocumentStackCard from "../work/DocumentStackCard.svelte";
  import AutomationRefCard from "../automations/AutomationRefCard.svelte";
  import TaskRefCard from "./TaskRefCard.svelte";
  import BrowserSnapshotCard from "../browser/BrowserSnapshotCard.svelte";
  import BrowserSnapshotGallery from "../browser/BrowserSnapshotGallery.svelte";
  import AgentConversationGroup from "./agent-conversation/AgentConversationGroup.svelte";
  import ArtifactView from "../artifact/ArtifactView.svelte";
  import ConversationArtifact from "./ConversationArtifact.svelte";
  import { getArtifactRevisions, provideArtifactMessage } from "./lib/artifact-revisions-context";
  import ReviewGuideCard from "../review/ReviewGuideCard.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";
  import MarkdownImage from "./MarkdownImage.svelte";
  import { RAW_HTML_TOKEN } from "./lib/raw-html";
  import FencedBlock from "./FencedBlock.svelte";
  import HtmlBlock from "./HtmlBlock.svelte";
  import { assistantMarkdownOptions, assistantMarkdownExtensions } from "./lib/assistant-markdown";
  import { noticeText } from "./lib/transient";
  import type { DocumentStackEntry } from "../work/lib/document-stack";

  let { item, skipMotion, tabId, linkContext, activeHandoffDivider, activeHandoffTargetModel,
    navigateToSourceSession }: {
    item: GroupedItem; skipMotion: boolean; tabId: string; linkContext: TaskLinkContext;
    activeHandoffDivider?: Message; activeHandoffTargetModel: string | null;
    navigateToSourceSession: (sessionId: string) => Promise<void>;
  } = $props();
  const session = getWorkspaceContext();
  const planStore = getPlanStore();
  const sess = $derived(session.sessionFor(tabId));
  const artifactRevisions = getArtifactRevisions();
  provideArtifactMessage(() => "message" in item ? item.message.id : undefined);
  const markdownRenderers = {
    code: FencedBlock,
    codespan: CodeSpan,
    image: MarkdownImage,
    link: MarkdownLink,
    [RAW_HTML_TOKEN]: HtmlBlock,
  };
  /** The store is the truth for a work's title and type; the message's
   *  own ref is the fallback that keeps a historical row named. */
  function documentStackEntries(messages: Message[]): DocumentStackEntry[] {
    const entries: DocumentStackEntry[] = [];
    for (const message of messages) {
      const ref = message.workRef;
      if (!ref?.workId) continue;
      const work = session.worksStore.get(ref.workId);
      entries.push({
        workId: ref.workId,
        title: work?.title ?? ref.title ?? "Untitled document",
        workType: work?.type ?? ref.workType,
        updatedAt: work?.updatedAt,
        streaming: session.worksStore.streaming[ref.workId] ?? false,
      });
    }
    return entries;
  }

</script>

{#snippet assistantBody(displayContent: string, streaming: boolean)}
  <div
    class="prose-cloud prose-reading prose-transcript prose-transcript-main min-w-0 response-markdown"
    data-streaming={streaming ? "" : undefined}
  >
    <SvelteMarkdown
      source={displayContent}
      streaming
      options={assistantMarkdownOptions}
      renderers={markdownRenderers}
      extensions={assistantMarkdownExtensions(displayContent)}
      sanitizeUrl={markdownSanitizeUrl}
    />
  </div>
{/snippet}

{#if item.kind === "user"}
  <UserMessageBubble message={item.message} {skipMotion} {tabId} />
{:else if item.kind === "assistant"}
  {@const displayContent = item.message.content}
  {#if displayContent}
    <!-- The rail hangs in the column's left margin; its copy
         control aligns with the first line of assistant prose. -->
    <div
      class="py-2 relative cv-rail-host {skipMotion
        ? ''
        : 'animate-msg-in-side'}"
      data-testid="assistant-message"
    >
      <!-- A hover rail needs somewhere to hover. That is the
           pointer, not the window: a touch laptop in a wide window
           has no hover either, and an iPad with a trackpad does. -->
      {#if !runtime.isTouchDevice}
        <MessageHoverRail
          timestamp={item.message.timestamp}
          text={displayContent}
        />
      {/if}
      <div
        class="cv-msg-body min-w-0"
        data-conversation-message-content
        data-conversation-message-id={item.message.id}
      >
        {@render assistantBody(displayContent, !skipMotion && !!sess?.isStreamingText)}
      </div>
    </div>
  {/if}
{:else if item.kind === "question"}
  <AnsweredQuestion message={item.message} />
{:else if item.kind === "tool-group"}
  <ToolGroupItem tools={item.messages} history={session.toolHistory} {skipMotion} />
{:else if item.kind === "subagent-group"}
  <SubagentGroup messages={item.messages} {tabId} {skipMotion} />
{:else if item.kind === "system"}
  {#if item.message.forkSourceSessionId}
    <TranscriptDivider
      glyphClass="text-(--solus-accent)"
      titleClass="text-(--solus-accent)"
      ariaLabel="Navigate to source session"
      onclick={() =>
        navigateToSourceSession(item.message.forkSourceSessionId!)}
      testid="fork-session-message"
      {skipMotion}
    >
      {#snippet glyph()}<GitForkIcon size={12} />{/snippet}
      {item.message.forkSourceRunning
        ? "Forked mid-run from"
        : "Forked from"}
      {#snippet title()}"{item.message.forkSourceTitle ||
          "session"}"{/snippet}
    </TranscriptDivider>
  {:else if item.message.worktreeMovedTo}
    <TranscriptDivider
      glyphClass="text-(--solus-accent)"
      titleClass="text-(--solus-accent)"
      testid="worktree-moved-message"
      {skipMotion}
    >
      {#snippet glyph()}<TreeStructureIcon size={12} />{/snippet}
      Continued in worktree
      {#snippet title()}{item.message.worktreeMovedTo}{/snippet}
    </TranscriptDivider>
  {:else if item.message.agentChangedTo}
    {@const sourceModel = modelLabelFor(
      item.message.agentChangedFromProvider,
      item.message.agentChangedFromModel,
    )}
    {@const targetModel = item.message === activeHandoffDivider
      ? activeHandoffTargetModel ?? item.message.agentChangedToModel
      : modelLabelFor(
          item.message.agentChangedToProvider,
          item.message.agentChangedToModel,
        )}
    <TranscriptDivider
      timestamp={item.message.timestamp}
      testid="agent-handoff-message"
      {skipMotion}
    >
      {#if sourceModel &&
      targetModel &&
      item.message.agentChangedFromProvider &&
      item.message.agentChangedToProvider}
        <span class="inline-flex max-w-full min-w-0 items-center gap-1.5 align-middle leading-none">
          <span class="inline-flex min-w-0 items-center gap-1">
            {#if item.message.agentChangedFromProvider === "claude-code"}
              <span class="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-(--solus-accent)"><ClaudeIcon size={11} /></span>
            {:else if item.message.agentChangedFromProvider === "codex"}
              <span class="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-white text-(--solus-accent)"><OpenAIBlossom size={11} /></span>
            {:else}
              <span class="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-(--solus-accent)"><CodeIcon size={11} /></span>
            {/if}
            <span class="truncate">{sourceModel}</span>
          </span>
          <ArrowRightIcon size={12} class="flex-shrink-0 text-(--solus-text-tertiary)" />
          <span class="inline-flex min-w-0 items-center gap-1 text-(--solus-accent)">
            {#if item.message.agentChangedToProvider === "claude-code"}
              <span class="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center"><ClaudeIcon size={11} /></span>
            {:else if item.message.agentChangedToProvider === "codex"}
              <span class="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-white"><OpenAIBlossom size={11} /></span>
            {:else}
              <span class="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center"><CodeIcon size={11} /></span>
            {/if}
            <span class="truncate">{targetModel}</span>
          </span>
        </span>
      {:else}
        Continued with
        {#snippet title()}{item.message.agentChangedTo}{/snippet}
      {/if}
    </TranscriptDivider>
  {:else if item.message.newSessionForPlanId}
    <!-- The implementation run keeps none of the planning
           session's context, only the plan. Stating that is what
           separates a deliberate restart from a lost thread. -->
    {@const acceptedPlan = planStore.get(
      item.message.newSessionForPlanId,
    )}
    <TranscriptDivider
      glyphClass="text-(--solus-accent)"
      titleClass="text-(--solus-accent)"
      timestamp={item.message.timestamp}
      testid="plan-new-session-message"
      {skipMotion}
    >
      {#snippet glyph()}<PlusCircleIcon size={12} />{/snippet}
      New session implementing
      {#snippet title()}"{acceptedPlan?.title ||
          "the plan"}"{/snippet}
    </TranscriptDivider>
  {:else}
    <!-- Cancellations, interrupts and errors alike: centred between
           hairlines, never a bubble and never tinted. A transient
           state is not a message, so it gets no fill of its own. -->
    <TranscriptDivider
      timestamp={item.message.timestamp}
      {skipMotion}
    >
      {noticeText(item.message.content)}
    </TranscriptDivider>
  {/if}
{:else if item.kind === "plan"}
  {@const plan = item.message.planId
    ? planStore.get(item.message.planId)
    : undefined}
  <PlanMessageItem
    ref={{
      kind: "plan",
      id: plan?.id,
      title: plan?.title,
      content: plan?.content,
      timestamp: plan?.timestamp,
      comments: plan?.comments,
      status: plan?.status,
      bookmarked: plan?.bookmarked,
    }}
    linkTarget={plan
      ? { kind: "plan", targetScope: plan.sessionId, targetKey: plan.planToolUseId }
      : undefined}
    {linkContext}
    {skipMotion}
  />
{:else if item.kind === "document"}
  <!-- One work is not a stack: a single write keeps the plain
       document card, and the fan begins at two. -->
  {#if item.messages.length === 1}
    {@const workMessage = item.messages[0]}
    {@const work = session.worksStore.get(
      workMessage.workRef?.workId ?? "",
    )}
    <PlanMessageItem
      ref={{
        kind: "document",
        id: workMessage.workRef?.workId,
        title: work?.title ?? workMessage.workRef?.title,
        content: work?.content,
        updatedAt: work?.updatedAt,
        workType: work?.type ?? workMessage.workRef?.workType,
        streaming: workMessage.workRef?.workId
          ? session.worksStore.streaming[workMessage.workRef.workId]
          : false,
      }}
      linkTarget={workMessage.workRef?.workId
        ? { kind: "work", targetScope: "", targetKey: workMessage.workRef.workId }
        : undefined}
      {linkContext}
      {skipMotion}
    />
  {:else}
    <DocumentStackCard
      entries={documentStackEntries(item.messages)}
      {linkContext}
      {skipMotion}
    />
  {/if}
{:else if item.kind === "automation" && item.message.automationRef}
  <AutomationRefCard
    ref={item.message.automationRef}
    {linkContext}
    {skipMotion}
  />
{:else if item.kind === "task" && item.message.taskRef}
  <TaskRefCard ref={item.message.taskRef} {skipMotion} />
{:else if item.kind === "browser-snapshot"}
  <!-- One capture is not a gallery: a single frame keeps the card
       with its full-width picture, and the plate begins at two. -->
  {@const captures = item.messages
    .map((message) => message.browserSnapshot)
    .filter((snapshot) => !!snapshot)}
  {#if captures.length === 1}
    <BrowserSnapshotCard
      snapshot={captures[0]}
      serverId={sess?.run.serverId}
      {skipMotion}
    />
  {:else if captures.length > 1}
    <BrowserSnapshotGallery
      snapshots={captures}
      serverId={sess?.run.serverId}
      {skipMotion}
    />
  {/if}
{:else if item.kind === "agent-conversation-group"}
  <AgentConversationGroup
    messages={item.messages}
    {tabId}
    {skipMotion}
  />
{:else if item.kind === "artifact" && item.message.artifact}
  {@const artifact = item.message.artifact}
  {@const revisions = item.message.workRef ? artifactRevisions?.().get(`work:${item.message.workRef.workId}`) : undefined}
  {@const revision = revisions?.find((entry) => entry.messageId === item.message.id)}
  {#if revisions && revision}
    <ConversationArtifact {revisions} {revision} />
  {:else if revisions && (artifact.pending || artifact.streaming)}
    <ConversationArtifact {revisions} update={artifact} />
  {:else}
  <ArtifactView
    artifact={item.message.artifact}
    workRef={item.message.workRef}
    {linkContext}
    {tabId}
    {skipMotion}
  />
  {/if}
{:else if item.kind === "review-guide" && item.message.reviewGuideRef}
  <ReviewGuideCard
    ref={item.message.reviewGuideRef}
    {tabId}
    {skipMotion}
  />
{/if}
