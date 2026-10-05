<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import { fly } from "svelte/transition";
  import {
    ChevronLeft as CaretLeftIcon,
    ChevronRight as CaretRightIcon,
    MessageSquareText as ChatTeardropTextIcon,
    Check as CheckIcon,
  } from "@lucide/svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";
  import InterruptCard from "./InterruptCard.svelte";
  import { Textarea } from "../ui/textarea";
  import { getWorkspaceContext } from "../../contexts";
  import {
    formatWaiting,
    inlineCodeParts,
    optionLabelParts,
  } from "./lib/interrupt";
  import { formatAnswer, questionKey } from "@solus/contracts/question-answer";
  import { requestExpiryText, type AgentId, type QuestionRequest, type QuestionItem } from "@solus/contracts/types";
  import { liveActivityClock } from "../../lib/shared-clock";
  import { conversationIsVisible } from "./lib/conversation-visibility";
  import { presenceStore } from "../../contexts/presence/presence.store.svelte";
  import { canDriveSession } from "../../contexts/sharing/session-drive";
  import { callTitle } from "../presence/lib/actor-name";

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
  // endings; `.prose-interrupt` keeps its indentation.
  const bodyRenderers = { code: CodeBlock, codespan: CodeSpan, link: MarkdownLink };

  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(tabId));
  // Addressed to the turn's author (plan 004 F2): "Waiting on Alice" to everyone else.
  const self = $derived(sess ? presenceStore.currentUserId(sess.run.serverId) : null);
  // A member who may only read the session reads the question but cannot answer it.
  const canDrive = $derived(canDriveSession(sess?.run.serverId, sess?.id));

  type QState = { selections: string[]; comment: string };

  let states = $state<Record<string, QState>>({});
  let currentIndex = $state(0);
  let responded = $state(false);
  // The host closed it unanswered (its run ended), or the answer was sent.
  const closed = $derived(responded || !!request.expired);
  let previewOpen = $state(true);
  // Callback questions pause a turn. Async questions can remain open after it ends.
  let askedAt = $state(Date.now());
  let now = $state(Date.now());

  $effect(() => {
    void request.questionId;
    const init: Record<string, QState> = {};
    for (const q of request.questions) {
      init[questionKey(q)] = { selections: [], comment: "" };
    }
    states = init;
    currentIndex = 0;
    responded = false;
    askedAt = Date.now();
  });

  const onScreen = conversationIsVisible();
  $effect(() => {
    if (closed || !onScreen()) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });

  $effect(() => {
    void currentIndex;
    previewOpen = true;
  });

  const total = $derived(request.questions.length);
  const currentQuestion = $derived(request.questions[currentIndex]);
  const isFirst = $derived(currentIndex === 0);
  const isLast = $derived(currentIndex === total - 1);
  const hasOptions = $derived((currentQuestion?.options.length ?? 0) > 0);
  const isMcpRequest = $derived(
    request.kind === "mcp_form" || request.kind === "mcp_url"
  );
  const primaryLabel = $derived(
    request.kind === "mcp_url" ? "Open" : isLast ? "Send answer" : "Next"
  );
  const waiting = $derived(formatWaiting(now - askedAt));

  /**
   * §11 — questions are a conversation, not a modal: an answered one collapses to
   * a single line carrying the choice made and a Change control, and the live
   * question takes the body. Only questions behind the current one can be
   * answered, so the trail always reads as history.
   */
  const trail = $derived(
    request.questions
      .slice(0, currentIndex)
      .map((question, index) => ({ question, index, answer: answerFor(question) }))
      .filter((entry) => entry.answer),
  );

  const activeOption = $derived.by(() => {
    const q = currentQuestion;
    if (!q || q.options.length === 0) return null;
    const selections = getSelections(q);
    const sel = q.options.find((o) => selections.includes(o.label));
    return sel ?? q.options[0];
  });

  const hasPreview = $derived(!!activeOption?.preview);

  function getSelections(q: QuestionItem): string[] {
    return states[questionKey(q)]?.selections ?? [];
  }

  function getComment(q: QuestionItem): string {
    return states[questionKey(q)]?.comment ?? "";
  }

  function ensureState(q: QuestionItem): QState {
    const key = questionKey(q);
    if (!states[key]) {
      states[key] = { selections: [], comment: "" };
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

  function answerFor(q: QuestionItem): string {
    return formatAnswer(getSelections(q).join(", "), getComment(q));
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

  function handleAction(action: "accept" | "decline" | "cancel") {
    if (closed || !canDrive || !request) return;
    responded = true;
    const answers: Record<string, string> = {};
    if (isMcpRequest) {
      answers.__action = action;
    }
    if (action === "accept") {
      for (const q of request.questions) {
        answers[questionKey(q)] = answerFor(q);
      }
    }
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
    } else if (e.key === "p" || e.key === "P") {
      if (hasPreview) {
        e.preventDefault();
        previewOpen = !previewOpen;
      }
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
  title={callTitle(request.serverName, request.turnAuthor, self)}
  blocking={request.responseMode !== "message"}
  target={provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : undefined}
  testId="question-card"
>
  {#snippet rail()}
    <span>{waiting}</span>
    {#if total > 1}
      <div class="flex shrink-0 items-center gap-1">
        <button
          type="button"
          class="interrupt-pager"
          disabled={closed || isFirst}
          aria-label="Previous question"
          onclick={goPrev}
        >
          <CaretLeftIcon size={14} weight="bold" />
        </button>
        <span class="interrupt-pager-count">{currentIndex + 1} of {total}</span>
        <button
          type="button"
          class="interrupt-pager"
          disabled={closed || isLast}
          aria-label="Next question"
          onclick={() => !isLast && (currentIndex += 1)}
        >
          <CaretRightIcon size={14} weight="bold" />
        </button>
      </div>
    {/if}
  {/snippet}

  {#if currentQuestion}
    {#key currentIndex}
      <div in:fly={{ y: 4, duration: 140 }} class="min-w-0">
        <!-- Answers stack as a numbered trail above the live question, each
             showing the choice made and reopenable in place. -->
        {#if trail.length > 0}
          <div class="flex flex-col gap-2 pt-3 pb-4">
            {#each trail as entry (entry.index)}
              <button
                type="button"
                class="trail-row flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[0.4375rem] text-left"
                disabled={closed}
                onclick={() => goTo(entry.index)}
              >
                <span class="trail-index">{entry.index + 1}</span>
                <CheckIcon size={14} weight="bold" class="trail-check" />
                <span class="min-w-0 flex-1 truncate text-transcript-meta text-(--muted-foreground)">
                  {entry.question.question}
                </span>
                <span class="shrink-0 text-transcript-meta opacity-40" aria-hidden="true">→</span>
                <span class="max-w-[45%] min-w-0 truncate text-transcript-meta font-medium">
                  {entry.answer}
                </span>
                <span class="trail-change">Change</span>
              </button>
            {/each}
          </div>
        {/if}

        <!-- The question is a sentence, not a heading: the header's title stays
             the card's only bold line. -->
        <div
          class="prose-cloud prose-reading prose-transcript prose-interrupt min-w-0 pb-2.5 text-transcript-card font-normal"
        >
          <SvelteMarkdown
            source={currentQuestion.question}
            options={{ breaks: true }}
            renderers={bodyRenderers}
            sanitizeUrl={markdownSanitizeUrl}
          />
        </div>

        {#if request.kind === "mcp_url" && request.url}
          <div class="pb-2 font-mono text-transcript-meta leading-relaxed break-all text-(--muted-foreground)">
            {request.url}
          </div>
        {/if}

        {#if currentQuestion.multiSelect && hasOptions}
          <div class="pb-2 text-transcript-meta text-(--muted-foreground)">
            Select all that apply
          </div>
        {/if}

        {#if hasOptions}
          <!-- Options are rows, not chips: each carries a consequence line,
               which is the part that makes the choice decidable. -->
          <div class="flex flex-col gap-2">
            {#each currentQuestion.options as opt, i (opt.label)}
              {@const selected = isSelected(currentQuestion, opt.label)}
              {@const label = optionLabelParts(opt.label)}
              <button
                type="button"
                class="option-row flex items-start gap-3 rounded-lg px-[0.6875rem] py-[0.5625rem] text-left"
                class:is-selected={selected}
                disabled={closed || !canDrive}
                aria-pressed={selected}
                onclick={() => toggleOption(currentQuestion, opt.label)}
              >
                <span class="option-index">{i + 1}</span>
                <span class="flex min-w-0 flex-1 flex-col gap-px">
                  <span class="text-transcript-card font-medium">
                    {#each inlineCodeParts(label.text) as part, p (p)}
                      {#if part.code}<code class="option-code">{part.text}</code
                        >{:else}{part.text}{/if}
                    {/each}{#if label.note}<span class="option-note"
                        >· {label.note}</span
                      >{/if}
                  </span>
                  {#if opt.description}
                    <span class="text-transcript-meta leading-[1.5] text-pretty text-(--muted-foreground)">
                      {#each inlineCodeParts(opt.description) as part, p (p)}
                        {#if part.code}<code class="option-code">{part.text}</code
                          >{:else}{part.text}{/if}
                      {/each}
                    </span>
                  {/if}
                </span>
                <span class="option-mark" aria-hidden="true">
                  {#if selected}
                    <CheckIcon size={14} weight="bold" />
                  {/if}
                </span>
              </button>
            {/each}
          </div>
        {/if}

        {#if hasPreview && activeOption}
          <div class="flex flex-col gap-1.5 pt-3">
            <button
              type="button"
              class="interrupt-disclosure self-start"
              aria-expanded={previewOpen}
              onclick={() => (previewOpen = !previewOpen)}
            >
              <span class="interrupt-caret" class:is-open={previewOpen}>
                <CaretRightIcon size={14} weight="bold" />
              </span>
              Preview “{activeOption.label}”
              <span class="key-chip">P</span>
            </button>
            {#if previewOpen}
              <div
                in:fly={{ y: -2, duration: 140 }}
                class="interrupt-payload px-[0.8125rem] py-[0.6875rem] text-transcript-meta leading-[1.75] whitespace-pre-wrap text-(--muted-foreground) [&_code]:!bg-transparent [&_p:last-child]:mb-0 [&_p]:mb-1 [&_p]:whitespace-pre-wrap [&_pre]:!bg-transparent [&_pre]:overflow-x-auto [&_pre]:whitespace-pre [&_strong]:font-medium [&_strong]:text-(--solus-text-primary)"
              >
                <SvelteMarkdown
                  source={activeOption.preview ?? ""}
                  options={{ breaks: true }}
                  renderers={{ link: MarkdownLink }}
                  sanitizeUrl={markdownSanitizeUrl}
                />
              </div>
            {/if}
          </div>
        {/if}

        <!-- Permanent: an off-menu reply must never require abandoning the card.
             Card fill, not a grey well — it is an alternative, not the emphasis. -->
        {#if canDrive}
        <div class="pt-3">
          <!-- The mic overlays the textarea, so its offsets are measured against
               that box, not this row. The box is this row's tallest item, so
               `--rc-mic-top:50%` puts the mic on the same centre line the ⏎ chip
               gets from `items-center` — they stay level as the answer wraps —
               and `--rc-mic-right` pulls it into the row gap so the mic sits 4px
               from that chip at either gap rung.

               The mic's strip is reserved with `mr-8`, not `pr-8`: margin keeps
               the strip outside the field's own box, so a long answer scrolls
               its thumb down the gutter's inner edge instead of over the words
               and under the mic. The cap stops the field growing until the
               footer — and its Send answer — leaves the viewport. -->
          <div class="answer-field flex items-center gap-2 rounded-lg px-2.5 py-2 [--rc-mic-top:50%] [--rc-mic-right:-0.25rem]">
            <ChatTeardropTextIcon size={14} class="shrink-0 text-(--muted-foreground)" />
            <Textarea
              name="question-answer"
              aria-label="Your answer"
              value={getComment(currentQuestion)}
              placeholder={hasOptions ? "Or answer in your own words…" : "Type your answer…"}
              disabled={closed}
              rows={1}
              mic
              class="max-h-[7.5rem] min-h-0 mr-8 rounded-none border-0 bg-transparent p-0 text-transcript-card font-normal shadow-none focus-visible:ring-0 dark:bg-transparent"
              oninput={(e) => {
                ensureState(currentQuestion).comment = (e.target as HTMLTextAreaElement).value;
              }}
            />
            <span class="key-chip shrink-0">⏎</span>
          </div>
        </div>
        {/if}
      </div>
    {/key}
  {/if}

  {#snippet footer()}
    {#if request.expired}
      <span class="text-transcript-meta text-(--muted-foreground)" data-testid="question-expired">{requestExpiryText(request.expired)}</span>
    {:else if !canDrive}
      <span class="text-transcript-meta text-(--muted-foreground)">Waiting for an editor</span>
    {:else}
    {#if isMcpRequest && (request.canDecline || request.canCancel)}
      <button
        type="button"
        class="tx-card-action is-ghost"
        disabled={closed}
        onclick={() => handleAction(request.canDecline ? "decline" : "cancel")}
      >
        {request.canDecline ? "Decline" : "Cancel"}
      </button>
    {:else}
      <button type="button" class="tx-card-action is-ghost" disabled={closed} onclick={handleDefer}>
        {request.responseMode === "message" ? "Dismiss" : "Let the agent decide"}
        <span class="interrupt-key">⌥⏎</span>
      </button>
    {/if}
    <div class="flex-1"></div>
    <button
      type="button"
      class="tx-card-action is-filled"
      disabled={closed}
      onclick={goNext}
    >
      {#if responded}
        <CheckIcon size={14} weight="bold" />
        Answered
      {:else}
        {primaryLabel}
        <span class="interrupt-key">{isLast ? "⌘⏎" : "→"}</span>
      {/if}
    </button>
    {/if}
  {/snippet}
</InterruptCard>

<style>
  .interrupt-pager {
    display: inline-flex;
    width: 1.5rem;
    height: 1.5rem;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 0.375rem;
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    color: var(--muted-foreground);
    cursor: pointer;
  }
  .interrupt-pager:disabled {
    background: transparent;
    opacity: 0.35;
    cursor: default;
  }
  .interrupt-pager-count {
    padding: 0 0.1875rem;
    font-size: var(--text-transcript-meta);
    font-variant-numeric: tabular-nums;
    color: var(--muted-foreground);
  }

  /* An answered question is history, so it sits in the neutral wash rather than
     keeping the selected tint that would make it compete with the live one. */
  .trail-row {
    border: none;
    background: color-mix(in oklch, var(--foreground) 3%, transparent);
    cursor: pointer;
    transition: background var(--duration-quick) var(--ease-premium);
  }
  .trail-row:hover:not(:disabled) {
    background: color-mix(in oklch, var(--foreground) 5%, transparent);
  }
  .trail-row:disabled {
    cursor: default;
  }

  .trail-index {
    width: 0.875rem;
    flex-shrink: 0;
    font-size: var(--text-transcript-meta);
    color: var(--muted-foreground);
    opacity: 0.5;
  }

  :global(.trail-check) {
    flex-shrink: 0;
    color: color-mix(in oklch, var(--solus-art-3) 62%, var(--foreground));
  }

  .trail-change {
    flex-shrink: 0;
    border-radius: 0.375rem;
    padding: 0.125rem 0.4375rem;
    font-size: var(--text-transcript-meta);
    font-weight: 500;
    color: var(--muted-foreground);
    transition: background var(--duration-quick) var(--ease-premium);
  }
  .trail-row:hover:not(:disabled) .trail-change {
    background: color-mix(in oklch, var(--foreground) 7%, transparent);
  }

  /* "recommended" is a note about the option, never part of its name. */
  .option-note {
    margin-left: 0.25rem;
    font-size: var(--text-transcript-meta);
    font-weight: 400;
    color: var(--muted-foreground);
  }

  /* A choice at rest is card fill and a hairline, like every other interactive
     surface on the card. Hover moves the border only — a fill shift on hover
     would read as a second selected row. */
  .option-row {
    border: 0.0625rem solid var(--solus-tx-divider);
    background: transparent;
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      border-color var(--duration-quick) var(--ease-premium),
      box-shadow var(--duration-quick) var(--ease-premium);
  }
  .option-row:hover:not(:disabled) {
    border-color: color-mix(in oklch, var(--primary) 25%, var(--solus-tx-divider));
  }
  .option-row.is-selected {
    border-color: color-mix(in oklch, var(--primary) 60%, transparent);
  }
  .option-row:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.125rem;
  }
  .option-row:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* §11 — inline code in an option is a chip, at the option's own size. */
  .option-code {
    padding: 0.0625rem 0.25rem;
    border-radius: 0.25rem;
    background: color-mix(in oklch, var(--foreground) 7%, transparent);
    font-family: var(--solus-code-font-family);
    font-size: 1em;
  }

  /* Number keys select, so the number is part of the row — and it stays neutral
     when selected, because the card only gets one terracotta. */
  .option-index {
    display: inline-flex;
    width: 1.125rem;
    height: 1.125rem;
    flex-shrink: 0;
    margin-top: 0.0625rem;
    align-items: center;
    justify-content: center;
    border: 0.0625rem solid var(--border);
    border-radius: 0.25rem;
    color: var(--muted-foreground);
    font-size: var(--text-transcript-meta);
  }

  .option-mark {
    display: inline-flex;
    width: 0.9375rem;
    height: 0.9375rem;
    flex-shrink: 0;
    margin-top: 0.125rem;
    align-items: center;
    justify-content: center;
    color: var(--primary);
  }

  .answer-field {
    border: 0.0625rem solid var(--solus-tx-divider);
    background: transparent;
    transition: border-color var(--duration-quick) var(--ease-premium);
  }
  .answer-field:focus-within {
    border-color: color-mix(in oklch, var(--primary) 45%, var(--border));
  }

  /* A key hint that names a control rather than living inside a button. */
  .key-chip {
    border: 0.0625rem solid var(--border);
    border-radius: 0.25rem;
    padding: 0 0.25rem;
    color: var(--muted-foreground);
    font-size: var(--text-transcript-meta);
    line-height: 1.5;
  }

  @media (pointer: coarse) {
    .interrupt-pager {
      width: 2rem;
      height: 2rem;
    }
    .option-row {
      min-height: 3rem;
    }
  }
</style>
