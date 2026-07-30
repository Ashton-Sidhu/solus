<script lang="ts">
  import { fly } from "svelte/transition";
  import {
    CaretLeftIcon,
    CaretRightIcon,
    CaretDownIcon,
    ChatTeardropTextIcon,
    CheckIcon,
  } from "phosphor-svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";
  import TranscriptChip from "./TranscriptChip.svelte";
  import Kbd from "../ui/Kbd.svelte";
  import { Textarea } from "../ui/textarea";
  import { getWorkspaceContext } from "../../contexts";
  import {
    formatWaiting,
    inlineCodeParts,
    optionLabelParts,
    ordinal,
  } from "./lib/interrupt";
  import type { AgentId, QuestionRequest, QuestionItem } from "../../../shared/types";

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
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
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
    request.kind === "mcp_url" ? "Open" : isLast ? "Answer & continue" : "Next"
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

  function questionKey(q: QuestionItem): string {
    return q.id || q.question;
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
    const sel = getSelections(q).join(", ");
    const comment = getComment(q).trim();
    if (sel && comment) return `${sel} — ${comment}`;
    return sel || comment;
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
      void window.solus.openExternal(request.url);
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
    const target = e.target as HTMLElement | null;
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

<div transition:fly={{ y: 8, duration: 200 }} class="mx-auto my-2 w-[88%]" data-testid="question-card">
  <div class="interrupt-card overflow-hidden rounded-xl">
    <div class="interrupt-header flex items-start gap-3 px-[1.0625rem] pt-[0.9375rem] pb-[0.8125rem]">
      <div class="min-w-0 flex-1">
        <div class="interrupt-kicker">Question</div>
        <div class="flex min-w-0 items-center gap-2">
          <span class="truncate text-[0.875rem] leading-tight font-semibold tracking-[-0.012em]">
            {request.serverName ? `${request.serverName} needs your call` : "Needs your call"}
          </span>
          <TranscriptChip state="active">Waiting on you</TranscriptChip>
        </div>
        <div class="mt-0.5 flex flex-wrap items-center gap-2 text-[0.71875rem] text-(--muted-foreground)">
          {#if sessionId}
            <span>{assistantName} <span class="font-mono">{sessionId}</span></span>
            <span class="opacity-40">·</span>
          {/if}
          {#if total > 1}
            <span class="text-(--solus-text-primary)">{ordinal(currentIndex + 1)} of {total}</span>
            <span class="opacity-40">·</span>
          {/if}
          <span class="font-mono">waiting {waiting}</span>
        </div>
      </div>
      {#if total > 1}
        <div class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            class="interrupt-pager"
            disabled={responded || isFirst}
            aria-label="Previous question"
            onclick={goPrev}
          >
            <CaretLeftIcon size={11} weight="bold" />
          </button>
          <span class="interrupt-pager-count font-mono">{currentIndex + 1} of {total}</span>
          <button
            type="button"
            class="interrupt-pager"
            disabled={responded || isLast}
            aria-label="Next question"
            onclick={() => !isLast && (currentIndex += 1)}
          >
            <CaretRightIcon size={11} weight="bold" />
          </button>
        </div>
      {/if}
    </div>

    {#if currentQuestion}
      {#key currentIndex}
        <div in:fly={{ y: 4, duration: 140 }} class="px-4 pt-[0.8125rem]">
          <!-- Answers stack as a numbered trail above the live question, each
               showing the choice made and reopenable in place. -->
          {#if trail.length > 0}
            <div class="mb-[0.6875rem] flex flex-col gap-[0.1875rem]">
              {#each trail as entry (entry.index)}
                <button
                  type="button"
                  class="trail-row flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[0.4375rem] text-left"
                  disabled={responded}
                  onclick={() => goTo(entry.index)}
                >
                  <span class="trail-index font-mono">{entry.index + 1}</span>
                  <CheckIcon size={11} weight="bold" class="trail-check" />
                  <span class="min-w-0 flex-1 truncate text-[0.75rem] text-(--muted-foreground)">
                    {entry.question.question}
                  </span>
                  <span class="shrink-0 text-[0.75rem] opacity-40" aria-hidden="true">→</span>
                  <span class="max-w-[45%] min-w-0 truncate text-[0.75rem] font-medium">
                    {entry.answer}
                  </span>
                  <span class="trail-change">Change</span>
                </button>
              {/each}
            </div>
          {/if}

          <div class="prose-cloud prose-reading prose-transcript prose-interrupt min-w-0">
            <SvelteMarkdown
              source={currentQuestion.question}
              options={{ breaks: true }}
              renderers={bodyRenderers}
              sanitizeUrl={markdownSanitizeUrl}
            />
          </div>

          {#if request.kind === "mcp_url" && request.url}
            <div class="mt-2 font-mono text-[0.71875rem] leading-relaxed break-all text-(--muted-foreground)">
              {request.url}
            </div>
          {/if}

          {#if currentQuestion.multiSelect && hasOptions}
            <div class="mt-2.5 text-[0.65625rem] tracking-[0.07em] uppercase text-(--muted-foreground)">
              Select all that apply
            </div>
          {/if}

          {#if hasOptions}
            <!-- Options are rows, not chips: each carries a consequence line,
                 which is the part that makes the choice decidable. -->
            <div class="mt-[0.8125rem] flex flex-col gap-1.5">
              {#each currentQuestion.options as opt, i (opt.label)}
                {@const selected = isSelected(currentQuestion, opt.label)}
                {@const label = optionLabelParts(opt.label)}
                <button
                  type="button"
                  class="option-row flex items-start gap-3 rounded-lg px-[0.6875rem] py-2.5 text-left"
                  class:is-selected={selected}
                  disabled={responded}
                  onclick={() => toggleOption(currentQuestion, opt.label)}
                >
                  <span class="option-index font-mono" class:is-selected={selected}>{i + 1}</span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-[0.8125rem] font-medium">
                      {#each inlineCodeParts(label.text) as part, p (p)}
                        {#if part.code}<code class="option-code">{part.text}</code
                          >{:else}{part.text}{/if}
                      {/each}{#if label.note}<span class="option-note"
                          >· {label.note}</span
                        >{/if}
                    </span>
                    {#if opt.description}
                      <span class="mt-0.5 block text-[0.75rem] leading-[1.5] text-pretty text-(--muted-foreground)">
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
                      <CheckIcon size={9} weight="bold" />
                    {/if}
                  </span>
                </button>
              {/each}
            </div>
          {/if}

          {#if hasPreview && activeOption}
            <div class="mt-2.5">
              <button
                type="button"
                onclick={() => (previewOpen = !previewOpen)}
                class="-ml-1 inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[0.71875rem] text-(--muted-foreground) hover:text-(--solus-text-primary)"
                title="Toggle preview (P)"
              >
                <span class="inline-flex transition-transform duration-150" style="transform:rotate({previewOpen ? 0 : -90}deg)">
                  <CaretDownIcon size={10} />
                </span>
                <span>About “{activeOption.label}”</span>
                <Kbd variant="inline">P</Kbd>
              </button>
              {#if previewOpen}
                <div
                  in:fly={{ y: -2, duration: 140 }}
                  class="option-preview mt-1.5 rounded-lg px-3 py-2 font-mono text-[0.71875rem] leading-relaxed whitespace-pre-wrap text-(--muted-foreground) [&_code]:!bg-transparent [&_p:last-child]:mb-0 [&_p]:mb-1 [&_p]:whitespace-pre-wrap [&_pre]:!bg-transparent [&_pre]:overflow-x-auto [&_pre]:whitespace-pre [&_strong]:font-semibold [&_strong]:text-(--solus-text-primary)"
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

          <!-- Permanent: an off-menu reply must never require abandoning the card. -->
          <div class="answer-field mt-2.5 flex items-start gap-2 rounded-lg px-[0.6875rem] py-2">
            <ChatTeardropTextIcon size={13} class="mt-0.5 shrink-0 text-(--muted-foreground) opacity-50" />
            <Textarea
              value={getComment(currentQuestion)}
              placeholder={hasOptions ? "Answer in your own words…" : "Type your answer…"}
              disabled={responded}
              rows={1}
              class="min-h-0 rounded-none border-0 bg-transparent p-0 text-[0.8125rem] font-normal shadow-none focus-visible:ring-0 dark:bg-transparent"
              oninput={(e) => {
                ensureState(currentQuestion).comment = (e.target as HTMLTextAreaElement).value;
              }}
            />
            <span class="answer-key font-mono shrink-0">↵</span>
          </div>
        </div>
      {/key}
    {/if}

    <!-- Escape hatch left, affirmative right. -->
    <div class="interrupt-footer mt-3 flex items-center gap-2 px-3 pt-[0.6875rem] pb-3">
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
        </button>
      {/if}
      <span class="flex-1"></span>
      <span class="interrupt-note">
        {responded ? "Answered" : `Holding for your answer · ${waiting}`}
      </span>
      <button
        type="button"
        class="interrupt-btn interrupt-btn--primary"
        disabled={responded}
        onclick={goNext}
      >
        {#if responded}
          <CheckIcon size={11} weight="bold" />
          Answered
        {:else}
          {primaryLabel}
          <span class="interrupt-key">{isLast ? "⌘↵" : "→"}</span>
        {/if}
      </button>
    </div>
  </div>
</div>

<style>
  /* .interrupt-card / .interrupt-btn chrome is shared with PermissionCard. */
  .interrupt-card {
    background: var(--card);
    box-shadow: var(--solus-tx-card-shadow);
  }

  .interrupt-header {
    border-bottom: 0.0625rem solid var(--solus-tx-rule);
  }

  .interrupt-kicker {
    margin-bottom: 0.3125rem;
    font-size: 0.59375rem;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted-foreground);
    opacity: 0.7;
  }

  .interrupt-footer {
    border-top: 0.0625rem solid var(--solus-tx-rule);
  }

  .interrupt-note {
    font-size: 0.71875rem;
    color: var(--muted-foreground);
  }

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
    font-size: 0.6875rem;
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
    font-size: 0.65625rem;
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
    font-size: 0.6875rem;
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
    font-size: 0.71875rem;
    font-weight: 400;
    color: var(--muted-foreground);
  }

  .option-row {
    border: none;
    background: transparent;
    box-shadow: inset 0 0 0 0.03125rem
      color-mix(in oklch, var(--foreground) 11%, transparent);
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      box-shadow var(--duration-quick) var(--ease-premium);
  }
  .option-row:hover:not(:disabled) {
    background: color-mix(in oklch, var(--foreground) 3%, transparent);
  }
  .option-row.is-selected {
    background: color-mix(in oklch, var(--primary) 7%, transparent);
    box-shadow: inset 0 0 0 0.0625rem
      color-mix(in oklch, var(--primary) 42%, transparent);
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
    font-size: 0.9em;
  }

  /* Number keys select, so the number is part of the row. */
  .option-index {
    display: inline-flex;
    width: 1.125rem;
    height: 1.125rem;
    flex-shrink: 0;
    margin-top: 0.0625rem;
    align-items: center;
    justify-content: center;
    border-radius: 0.375rem;
    background: color-mix(in oklch, var(--foreground) 7%, transparent);
    color: var(--muted-foreground);
    font-size: 0.6875rem;
  }
  .option-index.is-selected {
    background: var(--primary);
    color: var(--primary-foreground);
  }

  .option-mark {
    display: inline-flex;
    width: 0.9375rem;
    height: 0.9375rem;
    flex-shrink: 0;
    margin-top: 0.125rem;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    color: var(--primary-foreground);
    box-shadow: inset 0 0 0 0.0625rem
      color-mix(in oklch, var(--foreground) 20%, transparent);
  }
  .option-mark.is-multi {
    border-radius: 0.25rem;
  }
  .option-mark.is-selected {
    background: var(--primary);
    box-shadow: inset 0 0 0 0.21875rem var(--card), 0 0 0 0.0625rem var(--primary);
  }
  .option-mark.is-multi.is-selected {
    box-shadow: 0 0 0 0.0625rem var(--primary);
  }

  .option-preview,
  .answer-field {
    background: color-mix(in oklch, var(--foreground) 3%, transparent);
    box-shadow: inset 0 0 0 0.03125rem
      color-mix(in oklch, var(--foreground) 8%, transparent);
  }

  .answer-key {
    padding: 0.125rem 0.3125rem;
    border-radius: 0.25rem;
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    color: var(--muted-foreground);
    font-size: 0.65625rem;
  }
</style>
