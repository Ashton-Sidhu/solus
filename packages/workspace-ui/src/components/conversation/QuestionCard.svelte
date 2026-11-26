<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import { fly } from "svelte/transition";
  import { Check as CheckIcon, Paperclip, PenLine as WriteIcon, X } from "@lucide/svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";
  import MarkdownList from "./MarkdownList.svelte";
  import MarkdownBlockquote from "./MarkdownBlockquote.svelte";
  import InterruptCard from "./InterruptCard.svelte";
  import { Textarea } from "../ui/textarea";
  import { Button } from "../ui/button";
  import { getWorkspaceContext, hosts } from "../../contexts";
  import { LOCAL_SERVER_ID } from "@solus/client-core/known-host";
  import { attachmentUploads, uploadFileObjects } from "../input/lib/attachment-uploads.svelte";
  import {
    formatWaiting,
    inlineCodeParts,
    optionLabelParts,
  } from "./lib/interrupt";
  import { formatAnswer, previewMarkdown, questionKey, questionTakesAttachments } from "@solus/contracts/question-answer";
  import { requestExpiryText, type AgentId, type QuestionRequest, type QuestionItem } from "@solus/contracts/types";
  import { liveActivityClock } from "../../lib/shared-clock";
  import { conversationIsVisible } from "./lib/conversation-visibility";
  import { presenceStore } from "../../contexts/presence/presence.store.svelte";
  import { canDriveSession } from "../../contexts/sharing/resource-roles";
  import { othersTurnLabel } from "../presence/lib/actor-name";
  import { runHost } from "../../contexts/workspace/run-location";
  import { formatComboText } from "../../lib/keybindings/match";

  const deferKey = formatComboText({ alt: true, code: "Enter" });
  const submitKey = formatComboText({ mod: true, code: "Enter" });

  interface Props {
    tabId: string;
    request: QuestionRequest;
    provider?: AgentId | null;
    /** Answers for another session — a child this conversation sent work to.
     *  Unset, the answer goes to this tab's own session. */
    respond?: (questionId: string, answers: Record<string, string>) => Promise<boolean> | void;
    /** Whether the card's global keys act. Off while the tab holds a question of
     *  its own, so one keystroke never answers two cards. */
    shortcuts?: boolean;
  }

  let { tabId, request, provider = null, respond, shortcuts = true }: Props = $props();

  // §11 — the body is the assistant's own renderer, so a fenced block keeps its
  // chrome strip and its Copy. `breaks` keeps a hand-drawn question's line
  // endings; `.prose-question` keeps its indentation.
  const bodyRenderers = { code: CodeBlock, codespan: CodeSpan, link: MarkdownLink, list: MarkdownList, blockquote: MarkdownBlockquote };

  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(tabId));
  // Addressed to the turn's author (plan 004 F2): "Waiting on Alice" to everyone else.
  const self = $derived(sess ? presenceStore.currentUserId(runHost(sess.run)) : null);
  // A member who may only read the session reads the question but cannot answer it.
  const canDrive = $derived(canDriveSession(runHost(sess?.run), sess?.id, "drive.approve"));
  const serverId = $derived(runHost(sess?.run) ?? LOCAL_SERVER_ID);
  const canAttach = $derived(
    questionTakesAttachments(request) && !respond &&
    hosts.get(serverId)?.capabilityRecord?.attachUpload === true &&
    canDriveSession(serverId, sess?.id, "drive.prompt"),
  );
  const agentName = $derived(provider === "codex" ? "Codex" : provider === "claude-code" ? "Claude" : "the agent");
  // Who asks, in the eyebrow: an MCP server by name, a teammate's turn (plan 004 F2), else the agent.
  const othersTurn = $derived(othersTurnLabel(request.turnAuthor, self));
  const eyebrow = $derived(
    `${request.serverName ?? othersTurn ?? (agentName === "the agent" ? "The agent" : agentName)} asks${request.responseMode === "message" ? " · turn continues" : ""}`,
  );

  // The typed remark lives on the request (`request.remarks`), so it stays when
  // the card mounts again and goes back to the composer if the question closes
  // unanswered. The selections stay here: they mean nothing outside the card.
  type QState = { selections: string[]; files: File[] };

  let states = $state<Record<string, QState>>({});
  let currentIndex = $state(0);
  let responded = $state(false);
  let isUploading = $state(false);
  let attachmentError = $state("");
  let answerField = $state<HTMLTextAreaElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  // The host closed it unanswered (its run ended), or the answer was sent.
  const closed = $derived(responded || isUploading || !!request.expired);
  // Callback questions pause a turn. Async questions can remain open after it ends.
  let askedAt = $state(Date.now());
  let now = $state(Date.now());

  $effect(() => {
    void request.questionId;
    const init: Record<string, QState> = {};
    for (const q of request.questions) {
      init[questionKey(q)] = { selections: [], files: [] };
    }
    states = init;
    currentIndex = 0;
    responded = false;
    isUploading = false;
    attachmentError = "";
    askedAt = Date.now();
  });

  const onScreen = conversationIsVisible();
  $effect(() => {
    if (closed || !onScreen()) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });

  const total = $derived(request.questions.length);
  const currentQuestion = $derived(request.questions[currentIndex]);
  const files = $derived(states[questionKey(currentQuestion)]?.files ?? []);
  const isFirst = $derived(currentIndex === 0);
  const isLast = $derived(currentIndex === total - 1);
  const hasOptions = $derived((currentQuestion?.options.length ?? 0) > 0);
  const isMcpRequest = $derived(
    request.kind === "mcp_form" || request.kind === "mcp_url"
  );
  const primaryLabel = $derived(
    request.kind === "mcp_url" ? "Open" : isLast ? "Send" : "Next"
  );
  const waiting = $derived(formatWaiting(now - askedAt));

  /**
   * §11 — questions are a conversation, not a modal: an earlier one collapses to
   * a single line carrying the choice made, and the live question takes the
   * body. Every earlier question keeps its line, answered or skipped, so the
   * reader can always go back to it.
   */
  const trail = $derived(
    request.questions
      .slice(0, currentIndex)
      .map((question, index) => ({ question, index, answer: answerFor(question) })),
  );

  // The options are compared by their previews, so one always shows: the
  // chosen option's, else the first option that has one (as on mobile).
  const previewOption = $derived.by(() => {
    const q = currentQuestion;
    if (!q) return null;
    const selections = getSelections(q);
    return (
      q.options.find((o) => selections.includes(o.label) && o.preview?.trim()) ??
      q.options.find((o) => o.preview?.trim()) ??
      null
    );
  });

  function getSelections(q: QuestionItem): string[] {
    return states[questionKey(q)]?.selections ?? [];
  }

  function getRemark(q: QuestionItem): string {
    return request.remarks?.[questionKey(q)] ?? "";
  }

  function ensureState(q: QuestionItem): QState {
    const key = questionKey(q);
    if (!states[key]) {
      states[key] = { selections: [], files: [] };
    }
    return states[key];
  }

  function toggleOption(q: QuestionItem, label: string) {
    if (closed || !canDrive) return;
    const s = ensureState(q);
    if (!q.multiSelect) {
      s.selections = s.selections.includes(label) ? [] : [label];
    } else {
      s.selections = s.selections.includes(label)
        ? s.selections.filter((l) => l !== label)
        : [...s.selections, label];
    }
  }

  function isSelected(q: QuestionItem, label: string): boolean {
    return getSelections(q).includes(label);
  }

  function answerFor(q: QuestionItem, paths?: string[]): string {
    return formatAnswer(getSelections(q).join(", "), getRemark(q), paths);
  }

  function goPrev() {
    if (closed || isFirst) return;
    currentIndex -= 1;
  }

  /** A trail row is a clickable target for the same move the pager makes. */
  function goTo(index: number) {
    if (closed) return;
    currentIndex = index;
  }

  function goNext() {
    if (closed) return;
    if (isLast) {
      handleSubmit();
    } else {
      currentIndex += 1;
    }
  }

  function handleSubmit() {
    if (closed || !request) return;
    if (request.kind === "mcp_url" && request.url) {
      void localApi.openExternal(request.url);
    }
    handleAction("accept");
  }

  async function handleAction(action: "accept" | "decline" | "cancel") {
    if (closed || !canDrive || !request) return;
    const questionId = request.questionId;
    const api = session.apiFor(tabId);
    const ctx = session.ctxFor(tabId);
    const remainsCurrent = () => request.questionId === questionId && !request.expired &&
      canDrive && session.apiFor(tabId) === api && session.sessionFor(tabId)?.id === ctx.session.sessionId;
    const answers: Record<string, string> = {};
    if (isMcpRequest) {
      answers.__action = action;
    }
    if (action === "accept") {
      try {
        for (const q of request.questions) {
          const files = states[questionKey(q)]?.files ?? [];
          const paths: string[] = [];
          for (const file of files) {
            if (!canAttach || !remainsCurrent()) return;
            isUploading = true;
            attachmentError = "";
            const [upload] = await uploadFileObjects(api, ctx, serverId, [file]);
            if (!upload) throw new Error("Could not start the upload.");
            const outcome = await attachmentUploads.landed(upload);
            if (outcome.status === "failed") {
              attachmentUploads.cancel(upload.id);
              throw new Error(outcome.message);
            }
            paths.push(outcome.attachment.path);
            if (!remainsCurrent()) return;
          }
          answers[questionKey(q)] = answerFor(q, paths);
        }
      } catch (error) {
        if (remainsCurrent()) attachmentError = error instanceof Error ? error.message : "Could not upload the attachment.";
        return;
      } finally {
        if (request.questionId === questionId) isUploading = false;
      }
    }
    responded = true;
    sendAnswers(answers);
  }

  /** An empty answer dismisses a Codex async question. Blocking callbacks
   *  deliver the empty answer to their provider. */
  function handleDefer() {
    if (closed || !canDrive || !request) return;
    responded = true;
    const answers: Record<string, string> = {};
    if (isMcpRequest) answers.__action = "accept";
    for (const q of request.questions) answers[questionKey(q)] = "";
    sendAnswers(answers);
  }

  function sendAnswers(answers: Record<string, string>) {
    const result = respond
      ? respond(request.questionId, answers)
      : session.controls.respondQuestion(tabId, request.questionId, answers);
    if (result) void result.then((answered) => {
      if (answered === false) responded = false;
    }).catch(() => { responded = false; });
  }

  // The card's keys act only in the active tab, and only when it owns them.
  const keysActive = $derived(shortcuts && canDrive && tabId === session.activeTabId);

  function handleKeydown(e: KeyboardEvent) {
    if (!keysActive || closed || !request) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    const tag = target?.tagName;
    const typing =
      tag === "TEXTAREA" ||
      tag === "INPUT" ||
      target?.isContentEditable === true;

    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
      return;
    }

    // Deferring is a decision too, so it gets a key like every other footer action.
    if (e.altKey && e.key === "Enter") {
      e.preventDefault();
      handleDefer();
      return;
    }

    if (typing) return;

    if (e.key === "ArrowRight") {
      e.preventDefault();
      goNext();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      goPrev();
    } else if (/^[1-9]$/.test(e.key)) {
      const idx = parseInt(e.key, 10) - 1;
      const q = currentQuestion;
      if (q && idx < q.options.length) {
        e.preventDefault();
        toggleOption(q, q.options[idx].label);
      }
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<InterruptCard
  type="question"
  title={eyebrow}
  blocking={request.responseMode !== "message"}
  testId="question-card"
>
  {#snippet rail()}
    {#if total > 1}<span>{currentIndex + 1} of {total}</span>{/if}
    <span>{waiting}</span>
  {/snippet}

  {#if currentQuestion}
    {#key currentIndex}
      <div in:fly={{ y: 4, duration: 140 }} class="flex min-w-0 flex-col gap-3.5">
        <div class="flex min-w-0 flex-col gap-1">
          <!-- Earlier questions stack as muted lines above the live one, each
               showing the choice made (or that it was skipped) and reopenable in place. -->
          {#if trail.length > 0}
            {#each trail as entry (entry.index)}
              <button
                type="button"
                class="trail-row flex w-full items-baseline gap-2 text-left text-transcript-meta text-(--muted-foreground)"
                disabled={closed}
                onclick={() => goTo(entry.index)}
              >
                <CheckIcon size={11} class="trail-check self-center {entry.answer ? '' : 'invisible'}" />
                <span class="min-w-0 truncate">{entry.question.question}</span>
                <span class="shrink-0 {entry.answer ? 'text-(--solus-text-secondary)' : 'italic'}">{entry.answer || "Skipped"}</span>
              </button>
            {/each}
            <div class="interrupt-divider my-2" aria-hidden="true"></div>
          {/if}

          <div class="prose prose-question interrupt-title min-w-0">
            <SvelteMarkdown
              source={currentQuestion.question}
              options={{ breaks: true }}
              renderers={bodyRenderers}
              sanitizeUrl={markdownSanitizeUrl}
            />
          </div>

          {#if request.kind === "mcp_url" && request.url}
            <div class="font-mono text-transcript-meta leading-relaxed break-all text-(--muted-foreground)">
              {request.url}
            </div>
          {/if}

          {#if currentQuestion.multiSelect && hasOptions}
            <p class="m-0 text-transcript-meta text-(--muted-foreground)">Select all that apply.</p>
          {/if}
        </div>

        {#if hasOptions}
          <!-- Options are soft rows, not boxes: a radio (or a checkbox for
               multi-select) leads, and each carries a consequence line, which is
               the part that makes the choice decidable. -->
          <div class="-mx-2 flex flex-col gap-0.5" role={currentQuestion.multiSelect ? "group" : "radiogroup"}>
            {#each currentQuestion.options as opt, i (opt.label)}
              {@const selected = isSelected(currentQuestion, opt.label)}
              {@const label = optionLabelParts(opt.label)}
              <button
                type="button"
                class="option-row flex items-start gap-2.5 px-2 py-1.5 text-left"
                class:is-selected={selected}
                role={currentQuestion.multiSelect ? "checkbox" : "radio"}
                aria-checked={selected}
                disabled={closed || !canDrive}
                onclick={() => toggleOption(currentQuestion, opt.label)}
              >
                <span
                  class="option-mark"
                  class:is-check={currentQuestion.multiSelect}
                  class:is-on={selected}
                  aria-hidden="true"
                >
                  {#if currentQuestion.multiSelect}<CheckIcon size={10} strokeWidth={3} />{/if}
                </span>
                <span class="flex min-w-0 flex-1 flex-col gap-px">
                  <span class="option-label text-xs leading-relaxed">
                    {#each inlineCodeParts(label.text) as part, p (p)}
                      {#if part.code}<code class="option-code">{part.text}</code
                        >{:else}{part.text}{/if}
                    {/each}{#if label.note}<span class="option-note"
                        >{label.note}</span
                      >{/if}
                  </span>
                  {#if opt.description}
                    <span class="text-[0.6875rem] leading-relaxed text-pretty text-(--muted-foreground)">
                      {#each inlineCodeParts(opt.description) as part, p (p)}
                        {#if part.code}<code class="option-code">{part.text}</code
                          >{:else}{part.text}{/if}
                      {/each}
                    </span>
                  {/if}
                </span>
                <span class="interrupt-key option-index mt-0.5 shrink-0">{i + 1}</span>
              </button>
            {/each}
          </div>
        {/if}

        {#if previewOption?.preview}
          <!-- A monospace box, so a mockup keeps its columns; it scrolls rather than wraps. -->
          <div class="interrupt-payload" data-testid="question-preview">
            <div class="interrupt-payload-bar">
              <span class="interrupt-payload-label">{previewOption.label}</span>
            </div>
            <div
              class="max-h-[18rem] overflow-auto px-3.5 pt-1 pb-2.5 font-mono text-transcript-meta leading-relaxed text-(--solus-text-secondary) [&_code]:!bg-transparent [&_code]:!p-0 [&_p:last-child]:mb-0 [&_p]:mb-1.5 [&_pre]:m-0 [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:whitespace-pre [&_strong]:text-(--solus-text-primary)"
            >
              <SvelteMarkdown
                source={previewMarkdown(previewOption.preview)}
                renderers={{ link: MarkdownLink }}
                sanitizeUrl={markdownSanitizeUrl}
              />
            </div>
          </div>
        {/if}

        <!-- Permanent: an off-menu reply must never require abandoning the card.
             It is one more row in the options' geometry: a pen in the mark
             column, the words in the label column at the label's size, on a
             soft fill. The action that sends it is the filled pill in the footer. -->
        {#if canDrive && !request.expired}
          <!-- The mic overlays the textarea, so its offsets are measured against
               that box. `mr-8` reserves its strip outside the field's own box, so
               a long answer scrolls under the words and not under the mic. The
               paperclip sits after the mic, at the mic's size, and its negative
               margin keeps a one-line row at the textarea's height. -->
          <div class="answer-row flex items-start gap-2 py-1.5 pr-2 pl-1.5 [--rc-mic-top:50%] [--rc-mic-right:-0.25rem]">
            <span class="answer-mark" aria-hidden="true"><WriteIcon size={12} /></span>
            <Textarea
              bind:ref={answerField}
              name="question-answer"
              aria-label="Your answer"
              value={getRemark(currentQuestion)}
              placeholder={hasOptions ? "Something else…" : "Write your answer…"}
              disabled={closed}
              rows={1}
              mic
              class="max-h-[7.5rem] min-h-0 mr-8 rounded-none border-0 bg-transparent p-0 text-xs leading-relaxed! font-normal shadow-none placeholder:leading-relaxed! focus-visible:ring-0 dark:bg-transparent"
              oninput={(e) => {
                (request.remarks ??= {})[questionKey(currentQuestion)] = (e.target as HTMLTextAreaElement).value;
              }}
            />
            {#if canAttach}
              <input
                bind:this={fileInput}
                type="file"
                multiple
                class="hidden"
                disabled={closed}
                onchange={(event) => {
                  const input = event.currentTarget;
                  ensureState(currentQuestion).files.push(...Array.from(input.files ?? []));
                  input.value = "";
                  attachmentError = "";
                  answerField?.focus();
                }}
              />
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={closed}
                onmousedown={(e) => e.preventDefault()}
                onclick={() => fileInput?.click()}
                aria-label="Attach files to answer"
                title="Attach files"
                class="-my-1.5 size-7 shrink-0 self-center rounded-full text-(--solus-mic-color) hover:bg-(--solus-mic-bg) hover:text-(--solus-mic-color)"
              ><Paperclip size={14} /></Button>
            {/if}
          </div>
          <!-- The chosen files, in the label column under the words. -->
          {#if canAttach && (files.length || isUploading || attachmentError)}
            <div class="flex flex-wrap items-center gap-1.5 pl-7.5">
              {#each files as file, index}
                <span class="flex max-w-[11.25rem] items-center gap-1 rounded-[0.625rem] bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] py-0.5 pr-1 pl-2 text-xs text-(--solus-text-secondary)">
                  <span class="min-w-0 truncate">{file.name}</span>
                  <button
                    type="button"
                    disabled={closed}
                    aria-label={`Remove ${file.name}`}
                    onclick={() => {
                      ensureState(currentQuestion).files.splice(index, 1);
                      answerField?.focus();
                    }}
                    class="flex shrink-0 cursor-pointer items-center rounded text-(--solus-text-tertiary) hover:text-(--solus-text-primary) focus-visible:text-(--solus-text-primary) focus-visible:outline-none disabled:cursor-not-allowed pointer-coarse:min-h-11"
                  ><X size={12} /></button>
                </span>
              {/each}
              {#if isUploading}
                <span role="status" class="text-transcript-meta text-(--muted-foreground)">Uploading…</span>
              {:else if attachmentError}
                <span role="alert" class="text-transcript-meta text-(--destructive)">{attachmentError}</span>
              {/if}
            </div>
          {/if}
        {/if}
      </div>
    {/key}
  {/if}

  {#snippet footer()}
    <!-- One decision row, as on a permission card: Back at the left, the
         quiet way out as text, and the filled pill that sends. -->
    <div class="flex items-center justify-end gap-1">
      {#if !isFirst && !closed}
        <button type="button" class="interrupt-pill is-text mr-auto -ml-2" onclick={goPrev}>
          Back
          <span class="interrupt-key">←</span>
        </button>
      {/if}
      {#if request.expired}
        <span class="text-transcript-meta text-(--muted-foreground)" data-testid="question-expired">{requestExpiryText(request.expired)}</span>
      {:else if !canDrive}
        <span class="text-transcript-meta text-(--muted-foreground)">Waiting for an editor</span>
      {:else}
        {#if isMcpRequest && (request.canDecline || request.canCancel)}
          <button
            type="button"
            class="interrupt-pill is-text"
            disabled={closed}
            onclick={() => handleAction(request.canDecline ? "decline" : "cancel")}
          >
            {request.canDecline ? "Decline" : "Cancel"}
          </button>
        {:else}
          <button type="button" class="interrupt-pill is-text" disabled={closed} onclick={handleDefer}>
            {request.responseMode === "message" ? "Dismiss" : `Let ${agentName} decide`}
            <span class="interrupt-key">{deferKey}</span>
          </button>
        {/if}
        <button type="button" class="interrupt-pill is-filled" disabled={closed} onclick={goNext}>
          {#if responded}
            <CheckIcon size={12} strokeWidth={2.5} />
            Answered
          {:else}
            {primaryLabel}
            <span class="interrupt-key">{isLast ? submitKey : "→"}</span>
          {/if}
        </button>
      {/if}
    </div>
  {/snippet}
</InterruptCard>

<style>
  /* An answered question is history: a muted line the reader can reopen. */
  .trail-row {
    border: none;
    background: transparent;
    padding: 0;
    cursor: pointer;
    transition: color var(--duration-quick) var(--ease-premium);
  }
  .trail-row:hover:not(:disabled) {
    color: var(--solus-text-primary);
  }
  .trail-row:disabled {
    cursor: default;
  }
  :global(.trail-check) {
    flex-shrink: 0;
    color: color-mix(in oklch, var(--solus-art-3) 62%, var(--foreground));
  }

  /* "recommended" is a note about the option, never part of its name. */
  .option-note {
    margin-left: 0.375rem;
    font-size: 0.6875rem;
    font-weight: 400;
    color: var(--muted-foreground);
  }

  /* A choice is text on the card behind a radio; the radio alone shows the
     selection, and the label comes to full strength on hover and selection. */
  .option-row {
    border: none;
    border-radius: 0.5rem;
    background: transparent;
    cursor: pointer;
  }
  .option-row:focus-visible {
    outline: 0.125rem solid var(--solus-tx-focus-ring);
    outline-offset: 0.125rem;
  }
  .option-row:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .option-label {
    color: var(--solus-text-secondary);
    transition: color var(--duration-quick) var(--ease-premium);
  }
  .option-row:hover:not(:disabled) .option-label,
  .option-row.is-selected .option-label {
    color: var(--solus-text-primary);
  }

  /* The radio sits on the label's first line: 1rem box, centred on 1.625 × 0.75rem. */
  .option-mark {
    position: relative;
    display: inline-flex;
    width: 1rem;
    height: 1rem;
    margin-top: 0.1094rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    background: var(--solus-tx-card-bg);
    box-shadow: inset 0 0 0 0.09375rem color-mix(in oklch, var(--foreground) 22%, transparent);
    color: var(--primary-foreground);
    transition:
      background var(--duration-quick) var(--ease-premium),
      box-shadow var(--duration-quick) var(--ease-premium);
  }
  .option-row:hover:not(:disabled) .option-mark:not(.is-on) {
    box-shadow: inset 0 0 0 0.09375rem color-mix(in oklch, var(--foreground) 38%, transparent);
  }
  .option-mark::after {
    content: "";
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 9999px;
    background: var(--primary-foreground);
    transform: scale(0);
    transition: transform var(--duration-quick) var(--ease-premium);
  }
  .option-mark.is-on {
    background: var(--primary);
    box-shadow: inset 0 0 0 0.09375rem var(--primary);
  }
  .option-mark.is-on::after {
    transform: scale(1);
  }
  /* Multi-select: a rounded square holding a check instead of a dot. */
  .option-mark.is-check {
    border-radius: 0.3125rem;
  }
  .option-mark.is-check::after {
    content: none;
  }
  .option-mark.is-check :global(svg) {
    opacity: 0;
    transition: opacity var(--duration-quick) var(--ease-premium);
  }
  .option-mark.is-check.is-on :global(svg) {
    opacity: 1;
  }

  /* §11 — inline code in an option is a chip, at the option's own size. */
  .option-code {
    padding: 0.0625rem 0.25rem;
    border-radius: 0.25rem;
    background: color-mix(in oklch, var(--foreground) 7%, transparent);
    font-family: var(--solus-code-font-family);
    font-size: 1em;
  }

  /* The own-words row: an option row on a soft fill, no hairline at rest. A
     focused row darkens to the focus-ring hairline, as every field on a card. */
  .answer-row {
    border-radius: 0.5rem;
    background: color-mix(in oklch, var(--foreground) 3%, transparent);
    transition:
      background var(--duration-quick) var(--ease-premium),
      box-shadow var(--duration-quick) var(--ease-premium);
  }
  .answer-row:hover {
    background: color-mix(in oklch, var(--foreground) 4.5%, transparent);
  }
  .answer-row:focus-within {
    background: color-mix(in oklch, var(--foreground) 4.5%, transparent);
    box-shadow: inset 0 0 0 0.0625rem var(--solus-tx-focus-ring);
  }
  /* The pen takes the radio's 1rem box and its top offset, so it sits on the first line. */
  .answer-mark {
    display: inline-flex;
    width: 1rem;
    height: 1rem;
    margin-top: 0.1094rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    color: var(--muted-foreground);
    transition: color var(--duration-quick) var(--ease-premium);
  }
  .answer-row:focus-within .answer-mark {
    color: var(--solus-text-secondary);
  }

  /* The digit that selects, at the row's end, visible with the other key hints. */
  .option-index {
    min-width: 0.75rem;
    text-align: right;
  }

  @media (pointer: coarse) {
    .option-row {
      min-height: 3rem;
    }
  }
</style>
