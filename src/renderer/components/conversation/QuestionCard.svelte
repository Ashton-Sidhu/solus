<script lang="ts">
  import * as Card from "../ui/card";
  import { fly } from "svelte/transition";
  import {
    ChatCircleTextIcon,
    CaretLeftIcon,
    CaretRightIcon,
    CaretDownIcon,
    PlusIcon,
    CheckIcon,
  } from "phosphor-svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import MarkdownLink from "./MarkdownLink.svelte";
  import Kbd from "../ui/Kbd.svelte";
  import { Textarea } from "../ui/textarea";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import type { AgentId, QuestionRequest, QuestionItem } from "../../../shared/types";

  interface Props {
    tabId: string;
    request: QuestionRequest;
    provider?: AgentId | null;
  }

  let { tabId, request, provider = null }: Props = $props();

  const session = getWorkspaceContext();

  type QState = { selections: string[]; comment: string };

  let states = $state<Record<string, QState>>({});
  let currentIndex = $state(0);
  let responded = $state(false);
  let noteOpen = $state(false);
  let previewOpen = $state(true);
  let noteInputEl = $state<HTMLTextAreaElement | null>(null);

  $effect(() => {
    void request.questionId;
    const init: Record<string, QState> = {};
    for (const q of request.questions) {
      init[questionKey(q)] = { selections: [], comment: "" };
    }
    states = init;
    currentIndex = 0;
    responded = false;
  });

  $effect(() => {
    void currentIndex;
    noteOpen = false;
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
  const primaryLabel = $derived(request.kind === "mcp_url" ? "Open" : "Submit");

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

  function openNote() {
    noteOpen = true;
  }

  $effect(() => {
    if (noteOpen && noteInputEl) {
      noteInputEl.focus();
    }
  });

  function closeNote() {
    noteOpen = false;
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

    if (typing) {
      if (e.key === "Escape" && noteOpen && hasOptions) {
        e.preventDefault();
        closeNote();
      }
      return;
    }

    if (e.key === "ArrowRight") {
      e.preventDefault();
      goNext();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      goPrev();
    } else if (e.key === "n" || e.key === "N") {
      if (hasOptions) {
        e.preventDefault();
        openNote();
      }
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

<div transition:fly={{ y: 8, duration: 200 }} class="mx-auto mt-2 mb-2 w-[88%]">
  <Card.Root
    class="gap-0 border border-(--solus-container-border) bg-(--solus-container-bg) px-4 py-3.5"
    style="border-radius:0.875rem;box-shadow:var(--solus-card-shadow)"
  >
    <div class="flex items-center justify-between gap-2">
      <div
        class="inline-flex items-center gap-1.5 bg-(--solus-accent-light) text-(--solus-accent) rounded-full px-2 py-0.5"
      >
        <ChatCircleTextIcon size={12} />
        <span class="text-xs sm:text-[0.6875rem] font-semibold"
          >{request.serverName || assistantName} has questions</span
        >
      </div>
      {#if total > 1}
        <span
          class="text-xs sm:text-[0.6563rem] font-medium text-(--solus-text-tertiary) tabular-nums"
        >
          {currentIndex + 1} / {total}
        </span>
      {/if}
    </div>

    {#if currentQuestion}
      {#key currentIndex}
        <div in:fly={{ y: 4, duration: 140 }} class="mt-3">
          {#if currentQuestion.header}
            <div
              class="text-[0.6563rem] font-semibold uppercase tracking-[0.08em] mb-1 text-(--solus-text-tertiary)"
            >
              {currentQuestion.header}
            </div>
          {/if}
          <div
            class="text-[0.8125rem] font-medium leading-snug text-(--solus-text-primary)"
          >
            {currentQuestion.question}
          </div>

          {#if request.kind === "mcp_url" && request.url}
            <div
              class="mt-2 text-[0.6875rem] leading-relaxed text-(--solus-text-tertiary) break-all"
            >
              {request.url}
            </div>
          {/if}

          {#if activeOption?.description}
            <div
              class="text-[0.75rem] leading-relaxed text-(--solus-text-secondary) mt-1.5"
            >
              {activeOption.description}
            </div>
          {/if}

          {#if currentQuestion.multiSelect && hasOptions}
            <div class="text-[0.6563rem] text-(--solus-text-tertiary) mt-2 mb-1.5">
              Select all that apply
            </div>
          {/if}

          {#if hasOptions}
            <div class="flex flex-wrap gap-1.5 mt-2.5">
              {#each currentQuestion.options as opt, i (opt.label)}
                {@const selected = isSelected(currentQuestion, opt.label)}
                <button
                  onclick={() => toggleOption(currentQuestion, opt.label)}
                  disabled={responded}
                  class="text-[0.7188rem] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1 border focus-visible:outline-2 focus-visible:outline focus-visible:outline-(--solus-accent-border-medium) {selected
                    ? 'bg-(--solus-accent-light) text-(--solus-accent) border-(--solus-accent-border)'
                    : 'bg-(--solus-surface-primary) text-(--solus-text-secondary) border-transparent hover:bg-(--solus-accent-light) hover:text-(--solus-accent) active:bg-(--solus-accent-light) active:text-(--solus-accent)'}"
                >
                  {#if currentQuestion.multiSelect && selected}
                    <CheckIcon size={10} class="opacity-70" />
                  {/if}
                  <span>{opt.label}</span>
                  {#if i < 9}
                    <span
                      class="text-[0.5938rem] text-(--solus-text-tertiary) tabular-nums ml-0.5"
                      >{i + 1}</span
                    >
                  {/if}
                </button>
              {/each}
            </div>
          {/if}

          {#if hasPreview && activeOption}
            <div class="mt-2.5">
              <button
                onclick={() => (previewOpen = !previewOpen)}
                class="inline-flex items-center gap-1 text-[0.6875rem] font-medium text-(--solus-text-tertiary) hover:text-(--solus-text-secondary) cursor-pointer px-1 -ml-1 py-0.5 rounded"
                title="Toggle preview (P)"
              >
                <span
                  class="inline-flex transition-transform duration-150"
                  style="transform:rotate({previewOpen ? 0 : -90}deg)"
                >
                  <CaretDownIcon size={10} />
                </span>
                <span>About "{activeOption.label}"</span>
                <Kbd variant="inline">P</Kbd>
              </button>
              {#if previewOpen}
                <div
                  in:fly={{ y: -2, duration: 140 }}
                  class="mt-1.5 rounded-lg bg-(--solus-code-bg) border border-(--solus-container-border) px-2.5 py-1.5 text-[0.6563rem] font-mono text-(--solus-text-secondary) leading-relaxed whitespace-pre-wrap [&_pre]:!bg-transparent [&_pre]:whitespace-pre [&_pre]:overflow-x-auto [&_code]:!bg-transparent [&_p]:mb-1 [&_p]:whitespace-pre-wrap [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_strong]:text-(--solus-text-primary)"
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

          {#if !hasOptions}
            <div
              class="mt-2.5 bg-(--solus-surface-primary) border border-(--solus-container-border) rounded-lg px-2.5 py-1.5"
            >
              <Textarea
                value={getComment(currentQuestion)}
                placeholder="Type your answer…"
                disabled={responded}
                rows={1}
                class="min-h-0 rounded-none border-0 bg-transparent p-0 text-[0.7813rem] shadow-none focus-visible:ring-0 dark:bg-transparent"
                oninput={(e) => {
                  ensureState(currentQuestion).comment = (e.target as HTMLTextAreaElement).value;
                }}
              />
            </div>
          {/if}
        </div>
      {/key}
    {/if}

    {#if hasOptions && currentQuestion && !responded && noteOpen}
      <div class="mt-3.5 border-b border-(--solus-container-border) pb-1">
        <Textarea
          bind:ref={noteInputEl}
          value={getComment(currentQuestion)}
          placeholder="Add a note…"
          rows={1}
          class="min-h-0 rounded-none border-0 bg-transparent p-0 text-[0.7813rem] shadow-none focus-visible:ring-0 dark:bg-transparent"
          oninput={(e) => {
            ensureState(currentQuestion).comment = (e.target as HTMLTextAreaElement).value;
          }}
        />
      </div>
    {/if}

    <div
      class="flex items-center justify-between mt-3 {total > 1
        ? 'pt-3 border-t border-(--solus-message-divider)'
        : ''}"
    >
      <div class="flex items-center gap-1">
        {#if total > 1}
          <button
            onclick={goPrev}
            disabled={responded || isFirst}
            title="Previous (←)"
            class="inline-flex items-center gap-1 px-2 py-1.5 rounded-full text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            <CaretLeftIcon size={12} />
          </button>
        {/if}
        {#if hasOptions && currentQuestion && !responded}
          {@const noteText = getComment(currentQuestion).trim()}
          {#if !noteOpen}
            <button
              onclick={openNote}
              title="Add a note (N)"
              class="inline-flex items-center gap-1 text-[0.6875rem] font-medium text-(--solus-text-tertiary) hover:text-(--solus-text-secondary) px-2 py-1 rounded-full cursor-pointer transition-colors {total >
              1
                ? 'ml-1'
                : ''}"
            >
              {#if noteText}
                <span
                  >Note: "{noteText.length > 24
                    ? noteText.slice(0, 24) + "…"
                    : noteText}"</span
                >
              {:else}
                <PlusIcon size={10} />
                <span>Add a note</span>
                <Kbd variant="inline">N</Kbd>
              {/if}
            </button>
          {/if}
        {/if}
        {#if isMcpRequest && !responded}
          <div class="flex items-center gap-1">
            {#if request.canDecline}
              <button
                onclick={() => handleAction("decline")}
                class="text-[0.6875rem] font-medium px-2 py-1 rounded-full text-(--solus-text-tertiary) hover:text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) cursor-pointer transition-colors"
              >
                Decline
              </button>
            {/if}
            {#if request.canCancel}
              <button
                onclick={() => handleAction("cancel")}
                class="text-[0.6875rem] font-medium px-2 py-1 rounded-full text-(--solus-text-tertiary) hover:text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) cursor-pointer transition-colors"
              >
                Cancel
              </button>
            {/if}
          </div>
        {/if}
      </div>

      <button
        onclick={goNext}
        disabled={responded}
        title={isLast ? `${primaryLabel} (⌘↵)` : "Next (→)"}
        class="text-[0.7188rem] font-semibold px-3.5 py-1.5 rounded-full border-0 inline-flex items-center gap-1 transition-colors cursor-pointer disabled:cursor-not-allowed {responded
          ? 'bg-(--solus-surface-primary) text-(--solus-text-tertiary)'
          : isLast
            ? 'bg-(--solus-accent) text-(--solus-text-on-accent) hover:opacity-90 active:opacity-90'
            : 'bg-(--solus-accent-light) text-(--solus-accent) hover:bg-(--solus-accent-soft) active:bg-(--solus-accent-soft)'}"
        style={responded || !isLast
          ? ""
          : "box-shadow:0 0.125rem 0.5rem var(--solus-send-glow)"}
      >
        {#if responded}
          <CheckIcon size={11} />
          <span>Answered</span>
        {:else if isLast}
          <span>{primaryLabel}</span>
          <Kbd variant="inline" class="opacity-60 ml-0.5">⌘↵</Kbd>
        {:else}
          <span>Next</span>
          <CaretRightIcon size={11} />
        {/if}
      </button>
    </div>
  </Card.Root>
</div>
