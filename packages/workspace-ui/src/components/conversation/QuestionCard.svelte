<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import { fly } from "svelte/transition";
  import {
    ChevronRight as CaretRightIcon,
    Check as CheckIcon,
  } from "@lucide/svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";
  import MarkdownList from "./MarkdownList.svelte";
  import MarkdownBlockquote from "./MarkdownBlockquote.svelte";
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
  const agentName = $derived(provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : "the agent");
  // Who asks, in the eyebrow: an MCP server by name, a teammate's turn (plan 004 F2), else the agent.
  const othersTurn = $derived(othersTurnLabel(request.turnAuthor, self));
  const eyebrow = $derived(
    `${request.serverName ?? othersTurn ?? (agentName === "the agent" ? "The agent" : agentName)} asks${request.responseMode === "message" ? " · turn continues" : ""}`,
  );

  // The typed remark lives on the request (`request.remarks`), so it stays when
  // the card mounts again and goes back to the composer if the question closes
  // unanswered. The selections stay here: they mean nothing outside the card.
  type QState = { selections: string[] };

  let states = $state<Record<string, QState>>({});
  let currentIndex = $state(0);
  let responded = $state(false);
  // The host closed it unanswered (its run ended), or the answer was sent.
  const closed = $derived(responded || !!request.expired);
  let previewOpen = $state(false);
  // Callback questions pause a turn. Async questions can remain open after it ends.
  let askedAt = $state(Date.now());
  let now = $state(Date.now());

  $effect(() => {
    void request.questionId;
    const init: Record<string, QState> = {};
    for (const q of request.questions) {
      init[questionKey(q)] = { selections: [] };
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
    previewOpen = false;
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
    request.kind === "mcp_url" ? "Open" : isLast ? "Send" : "Next"
  );
  const waiting = $derived(formatWaiting(now - askedAt));

  /**
   * §11 — questions are a conversation, not a modal: an answered one collapses to
   * a single line carrying the choice made, and the live question takes the
   * body. Only questions behind the current one can be answered, so the trail
   * always reads as history.
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
    return q.options.find((o) => selections.includes(o.label)) ?? null;
  });

  const hasPreview = $derived(!!activeOption?.preview);

  function getSelections(q: QuestionItem): string[] {
    return states[questionKey(q)]?.selections ?? [];
  }

  function getRemark(q: QuestionItem): string {
    return request.remarks?.[questionKey(q)] ?? "";
  }

  function ensureState(q: QuestionItem): QState {
    const key = questionKey(q);
    if (!states[key]) {
      states[key] = { selections: [] };
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
    return formatAnswer(getSelections(q).join(", "), getRemark(q));
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
          <!-- Answers stack as muted lines above the live question, each
               showing the choice made and reopenable in place. -->
          {#if trail.length > 0}
            {#each trail as entry (entry.index)}
              <button
                type="button"
                class="trail-row flex w-full items-baseline gap-2 text-left text-transcript-meta text-(--muted-foreground)"
                disabled={closed}
                onclick={() => goTo(entry.index)}
              >
                <CheckIcon size={11} class="trail-check self-center" />
                <span class="min-w-0 truncate">{entry.question.question}</span>
                <span class="shrink-0 text-(--solus-text-secondary)">{entry.answer}</span>
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
                <span class="mt-0.5 flex shrink-0 items-center gap-2">
                  {#if selected && opt.preview}
                    <!-- A nested control inside the row: a span with a role, so the row stays one button. -->
                    <span
                      class="interrupt-link inline-flex items-center gap-1"
                      role="button"
                      tabindex="0"
                      aria-expanded={previewOpen}
                      onclick={(e) => { e.stopPropagation(); previewOpen = !previewOpen; }}
                      onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); previewOpen = !previewOpen; } }}
                    >
                      <span class="interrupt-caret inline-flex" class:is-open={previewOpen}><CaretRightIcon size={11} /></span>
                      preview <span class="interrupt-key">P</span>
                    </span>
                  {/if}
                  <span class="interrupt-key option-index">{i + 1}</span>
                </span>
              </button>
            {/each}
          </div>
        {/if}

        {#if hasPreview && activeOption && previewOpen}
          <div
            in:fly={{ y: -2, duration: 140 }}
            class="interrupt-payload px-3.5 py-2.5 text-transcript-meta leading-[1.75] whitespace-pre-wrap text-(--muted-foreground) [&_code]:!bg-transparent [&_p:last-child]:mb-0 [&_p]:mb-1 [&_p]:whitespace-pre-wrap [&_pre]:!bg-transparent [&_pre]:overflow-x-auto [&_pre]:whitespace-pre [&_strong]:font-normal [&_strong]:text-(--solus-text-primary)"
          >
            <SvelteMarkdown
              source={activeOption.preview ?? ""}
              options={{ breaks: true }}
              renderers={{ link: MarkdownLink }}
              sanitizeUrl={markdownSanitizeUrl}
            />
          </div>
        {/if}

        <!-- Permanent: an off-menu reply must never require abandoning the card.
             The bar holds the words and the one action that sends them. -->
        {#if canDrive && !request.expired}
          <!-- The mic overlays the textarea, so its offsets are measured against
               that box. `mr-8` reserves its strip outside the field's own box, so
               a long answer scrolls under the words and not under the mic. -->
          <div class="interrupt-bar [--rc-mic-top:50%] [--rc-mic-right:-0.25rem]">
            <Textarea
              name="question-answer"
              aria-label="Your answer"
              value={getRemark(currentQuestion)}
              placeholder={hasOptions ? "Add your own words…" : "Write your answer…"}
              disabled={closed}
              rows={1}
              mic
              class="max-h-[7.5rem] min-h-0 mr-8 rounded-none border-0 bg-transparent p-0 text-transcript-card font-normal shadow-none focus-visible:ring-0 dark:bg-transparent"
              oninput={(e) => {
                (request.remarks ??= {})[questionKey(currentQuestion)] = (e.target as HTMLTextAreaElement).value;
              }}
            />
            <button type="button" class="interrupt-send" disabled={closed} onclick={goNext}>
              {#if responded}
                <CheckIcon size={13} strokeWidth={2.5} />
                Answered
              {:else}
                {primaryLabel}
                <span class="interrupt-key">{isLast ? submitKey : "→"}</span>
              {/if}
            </button>
          </div>
        {/if}
      </div>
    {/key}
  {/if}

  {#snippet footer()}
    <div class="flex items-center justify-end gap-3">
      {#if request.expired}
        <span class="text-transcript-meta text-(--muted-foreground)" data-testid="question-expired">{requestExpiryText(request.expired)}</span>
      {:else if !canDrive}
        <span class="text-transcript-meta text-(--muted-foreground)">Waiting for an editor</span>
      {:else if isMcpRequest && (request.canDecline || request.canCancel)}
        <button
          type="button"
          class="interrupt-link"
          disabled={closed}
          onclick={() => handleAction(request.canDecline ? "decline" : "cancel")}
        >
          {request.canDecline ? "Decline" : "Cancel"}
        </button>
      {:else}
        <button type="button" class="interrupt-link" disabled={closed} onclick={handleDefer}>
          {request.responseMode === "message" ? "Dismiss" : `Let ${agentName} decide`}
          <span class="interrupt-key">{deferKey}</span>
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
    outline: 0.125rem solid var(--solus-accent-border-medium);
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

  /* The digit that selects, at the row's end, visible with the other key hints. */
  .option-index {
    min-width: 0.75rem;
    text-align: right;
  }

  :global(.interrupt-caret) {
    transition: transform var(--duration-quick) var(--ease-premium);
  }
  :global(.interrupt-caret.is-open) {
    transform: rotate(90deg);
  }

  @media (pointer: coarse) {
    .option-row {
      min-height: 3rem;
    }
  }
</style>
