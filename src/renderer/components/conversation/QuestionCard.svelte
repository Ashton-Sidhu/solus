<script lang="ts">
  import { localApi } from "@client-core/local-api";
  import { fly } from "svelte/transition";
  import {
    CaretLeftIcon,
    CaretRightIcon,
    ChatTeardropTextIcon,
    CheckIcon,
  } from "phosphor-svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";
  import InterruptCard from "./InterruptCard.svelte";
  import TranscriptChip from "./TranscriptChip.svelte";
  import { Textarea } from "../ui/textarea";
  import { getWorkspaceContext } from "../../contexts";
  import {
    formatWaiting,
    inlineCodeParts,
    optionLabelParts,
    ordinal,
  } from "./lib/interrupt";
  import { formatAnswer, questionKey } from "../../../shared/question-answer";
  import type { AgentId, QuestionRequest, QuestionItem } from "../../../shared/types";
  import { liveActivityClock } from "../../lib/shared-clock";

  interface Props {
    tabId: string;
    request: QuestionRequest;
    provider?: AgentId | null;
  }

  let { tabId, request, provider = null }: Props = $props();

  // §11 — the body is the assistant's own renderer, so a fenced block keeps its
  // chrome strip and its Copy. `breaks` keeps a hand-drawn question's line
  // endings; `.prose-interrupt` keeps its indentation.
  const bodyRenderers = { code: CodeBlock, codespan: CodeSpan, link: MarkdownLink };

  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(tabId));

  type QState = { selections: string[]; comment: string };

  let states = $state<Record<string, QState>>({});
  let currentIndex = $state(0);
  let responded = $state(false);
  let previewOpen = $state(true);
  // A session with an open question is *waiting*, never idle or paused, and the
  // copy says what it is waiting for and how long it has held.
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

  $effect(() => {
    if (responded) return;
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
  const assistantName = $derived(provider === "codex" ? "Codex" : "Claude");
  const isMcpRequest = $derived(
    request.kind === "mcp_form" || request.kind === "mcp_url"
  );
  const primaryLabel = $derived(
    request.kind === "mcp_url" ? "Open" : isLast ? "Send answer" : "Next"
  );
  const waiting = $derived(formatWaiting(now - askedAt));
  const sessionId = $derived(sess?.agentSessionId?.slice(0, 8) ?? "");

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
    if (responded) return;
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
    if (responded || isFirst) return;
    currentIndex -= 1;
  }

  /** A trail row is a clickable target for the same move the pager makes. */
  function goTo(index: number) {
    if (responded) return;
    currentIndex = index;
  }

  function goNext() {
    if (responded) return;
    if (isLast) {
      handleSubmit();
    } else {
      currentIndex += 1;
    }
  }

  function handleSubmit() {
    if (responded || !request) return;
    if (request.kind === "mcp_url" && request.url) {
      void localApi.openExternal(request.url);
    }
    handleAction("accept");
  }

  function handleAction(action: "accept" | "decline" | "cancel") {
    if (responded || !request) return;
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
    session.respondQuestion(tabId, request.questionId, answers);
  }

  /** Hand the decision back rather than abandoning the card: every answer goes
   *  out empty, which is exactly what "you choose" means to the agent. */
  function handleDefer() {
    if (responded || !request) return;
    responded = true;
    const answers: Record<string, string> = {};
    if (isMcpRequest) answers.__action = "accept";
    for (const q of request.questions) answers[questionKey(q)] = "";
    session.respondQuestion(tabId, request.questionId, answers);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (tabId !== session.activeTabId || responded || !request) return;
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
  eyebrow="Question"
  title={request.serverName ? `${request.serverName} needs your call` : "Needs your call"}
  testId="question-card"
>
  {#snippet chip()}
    <TranscriptChip state="active">Waiting on you</TranscriptChip>
  {/snippet}

  {#snippet meta()}
    {#if sessionId}
      <span class="shrink-0">{assistantName} <span class="font-mono text-xs">{sessionId}</span></span>
      <span class="shrink-0 opacity-60">·</span>
    {/if}
    {#if total > 1}
      <span class="shrink-0 text-(--solus-text-primary)">{ordinal(currentIndex + 1)} of {total}</span>
      <span class="shrink-0 opacity-60">·</span>
    {/if}
    <span class="shrink-0 font-mono text-xs">waiting {waiting}</span>
  {/snippet}

  {#snippet headerAside()}
    {#if total > 1}
      <div class="flex shrink-0 items-center gap-1">
        <button
          type="button"
          class="interrupt-pager"
          disabled={responded || isFirst}
          aria-label="Previous question"
          onclick={goPrev}
        >
          <CaretLeftIcon size={14} weight="bold" />
        </button>
        <span class="interrupt-pager-count font-mono">{currentIndex + 1} of {total}</span>
        <button
          type="button"
          class="interrupt-pager"
          disabled={responded || isLast}
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
      <div in:fly={{ y: 4, duration: 140 }} class="pb-4">
        <!-- Answers stack as a numbered trail above the live question, each
             showing the choice made and reopenable in place. -->
        {#if trail.length > 0}
          <div class="flex flex-col gap-[0.1875rem] px-[1.125rem] pt-3">
            {#each trail as entry (entry.index)}
              <button
                type="button"
                class="trail-row flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[0.4375rem] text-left"
                disabled={responded}
                onclick={() => goTo(entry.index)}
              >
                <span class="trail-index font-mono">{entry.index + 1}</span>
                <CheckIcon size={14} weight="bold" class="trail-check" />
                <span class="min-w-0 flex-1 truncate text-xs text-(--muted-foreground)">
                  {entry.question.question}
                </span>
                <span class="shrink-0 text-xs opacity-40" aria-hidden="true">→</span>
                <span class="max-w-[45%] min-w-0 truncate text-xs font-medium">
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
          class="prose-cloud prose-reading prose-transcript prose-interrupt min-w-0 px-[1.125rem] pt-[0.9375rem] pb-3 text-sm font-normal"
        >
          <SvelteMarkdown
            source={currentQuestion.question}
            options={{ breaks: true }}
            renderers={bodyRenderers}
            sanitizeUrl={markdownSanitizeUrl}
          />
        </div>

        {#if request.kind === "mcp_url" && request.url}
          <div class="px-[1.125rem] pb-2 font-mono text-xs leading-relaxed break-all text-(--muted-foreground)">
            {request.url}
          </div>
        {/if}

        {#if currentQuestion.multiSelect && hasOptions}
          <div class="px-[1.125rem] pb-2 text-xs uppercase text-(--muted-foreground)">
            Select all that apply
          </div>
        {/if}

        {#if hasOptions}
          <!-- Options are rows, not chips: each carries a consequence line,
               which is the part that makes the choice decidable. -->
          <div class="flex flex-col gap-1.5 px-[1.125rem]">
            {#each currentQuestion.options as opt, i (opt.label)}
              {@const selected = isSelected(currentQuestion, opt.label)}
              {@const label = optionLabelParts(opt.label)}
              <button
                type="button"
                class="option-row flex items-start gap-3 rounded-lg px-[0.6875rem] py-[0.5625rem] text-left"
                class:is-selected={selected}
                disabled={responded}
                onclick={() => toggleOption(currentQuestion, opt.label)}
              >
                <span class="option-index font-mono">{i + 1}</span>
                <span class="flex min-w-0 flex-1 flex-col gap-px">
                  <span class="text-[0.8125rem] font-medium">
                    {#each inlineCodeParts(label.text) as part, p (p)}
                      {#if part.code}<code class="option-code">{part.text}</code
                        >{:else}{part.text}{/if}
                    {/each}{#if label.note}<span class="option-note"
                        >· {label.note}</span
                      >{/if}
                  </span>
                  {#if opt.description}
                    <span class="text-xs leading-[1.5] text-pretty text-(--muted-foreground)">
                      {#each inlineCodeParts(opt.description) as part, p (p)}
                        {#if part.code}<code class="option-code">{part.text}</code
                          >{:else}{part.text}{/if}
                      {/each}
                    </span>
                  {/if}
                </span>
                <span
                  class="option-mark"
                  class:is-selected={selected}
                  class:is-multi={currentQuestion.multiSelect}
                >
                  {#if selected && currentQuestion.multiSelect}
                    <CheckIcon size={14} weight="bold" />
                  {:else if selected}
                    <span class="option-dot"></span>
                  {/if}
                </span>
              </button>
            {/each}
          </div>
        {/if}

        {#if hasPreview && activeOption}
          <div class="flex flex-col gap-1.5 px-[1.125rem] pt-3">
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
              <span class="key-chip font-mono">P</span>
            </button>
            {#if previewOpen}
              <div
                in:fly={{ y: -2, duration: 140 }}
                class="interrupt-payload px-[0.8125rem] py-[0.6875rem] font-mono text-xs leading-[1.75] whitespace-pre-wrap text-(--muted-foreground) [&_code]:!bg-transparent [&_p:last-child]:mb-0 [&_p]:mb-1 [&_p]:whitespace-pre-wrap [&_pre]:!bg-transparent [&_pre]:overflow-x-auto [&_pre]:whitespace-pre [&_strong]:font-medium [&_strong]:text-(--solus-text-primary)"
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
        <div class="px-[1.125rem] pt-3">
          <div class="answer-field flex items-center gap-2 rounded-lg px-2.5 py-2">
            <ChatTeardropTextIcon size={14} class="shrink-0 text-(--muted-foreground)" />
            <Textarea
              value={getComment(currentQuestion)}
              placeholder={hasOptions ? "Or answer in your own words…" : "Type your answer…"}
              disabled={responded}
              rows={1}
              class="min-h-0 rounded-none border-0 bg-transparent p-0 text-[0.8125rem] font-normal shadow-none focus-visible:ring-0 dark:bg-transparent"
              oninput={(e) => {
                ensureState(currentQuestion).comment = (e.target as HTMLTextAreaElement).value;
              }}
            />
            <span class="key-chip shrink-0 font-mono">⏎</span>
          </div>
        </div>
      </div>
    {/key}
  {/if}

  {#snippet footer()}
    {#if isMcpRequest && (request.canDecline || request.canCancel)}
      <button
        type="button"
        class="interrupt-btn"
        disabled={responded}
        onclick={() => handleAction(request.canDecline ? "decline" : "cancel")}
      >
        {request.canDecline ? "Decline" : "Cancel"}
      </button>
    {:else}
      <button type="button" class="interrupt-btn" disabled={responded} onclick={handleDefer}>
        Let the agent decide
        <span class="interrupt-key">⌥⏎</span>
      </button>
    {/if}
    <div class="flex-1"></div>
    <span class="shrink-0 text-xs text-(--muted-foreground)">
      {#if responded}
        Answered
      {:else}
        Holding · <span class="font-mono text-xs">{waiting}</span>
      {/if}
    </span>
    <button
      type="button"
      class="interrupt-btn interrupt-btn--primary"
      disabled={responded}
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
    font-size: 0.75rem;
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
    font-size: 0.75rem;
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
    font-size: 0.75rem;
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
    font-size: 0.75rem;
    font-weight: 400;
    color: var(--muted-foreground);
  }

  /* A choice at rest is card fill and a hairline, like every other interactive
     surface on the card. Hover moves the border only — a fill shift on hover
     would read as a second selected row. */
  .option-row {
    border: 0.0625rem solid var(--border);
    background: var(--card);
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      border-color var(--duration-quick) var(--ease-premium),
      box-shadow var(--duration-quick) var(--ease-premium);
  }
  .option-row:hover:not(:disabled) {
    border-color: color-mix(in oklch, var(--primary) 25%, var(--border));
  }
  .option-row.is-selected {
    background: color-mix(in oklch, var(--primary) 7%, var(--card));
    border-color: color-mix(in oklch, var(--primary) 45%, var(--border));
    box-shadow: 0 0 0 0.0625rem color-mix(in oklch, var(--primary) 35%, transparent);
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
    font-size: 0.875rem;
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
    font-size: 0.75rem;
  }

  .option-mark {
    display: inline-flex;
    width: 0.9375rem;
    height: 0.9375rem;
    flex-shrink: 0;
    margin-top: 0.125rem;
    align-items: center;
    justify-content: center;
    border: 0.0625rem solid var(--border);
    border-radius: 9999px;
    color: var(--primary-foreground);
  }
  .option-mark.is-multi {
    border-radius: 0.25rem;
  }
  .option-mark.is-selected {
    border-color: var(--primary);
  }
  .option-mark.is-multi.is-selected {
    background: var(--primary);
  }
  .option-dot {
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: 9999px;
    background: var(--primary);
  }

  .answer-field {
    border: 0.0625rem solid var(--border);
    background: var(--card);
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
    font-size: 0.75rem;
    line-height: 1.5;
  }
</style>
