<script lang="ts">
  import { MessageCircle, ChevronRight, Check, MessageSquareText } from '@lucide/svelte';
  import type { Message, QuestionOption } from '@solus/contracts/types';
  import { questionKey } from '@solus/contracts/question-answer';
  import { parseQuestionInput } from '@solus/contracts/question-history';
  import TranscriptChip from './TranscriptChip.svelte';
  import { optionLabelParts } from './lib/interrupt';
  import { resolveAnswer } from './lib/answered-question';

  let { message }: { message: Message } = $props();
  const input = $derived(message.questionAnswer ?? parseQuestionInput(message.toolInput));
  const answers = $derived(input?.answers);
  const hasAnswers = $derived(!!answers);
  const questions = $derived(
    (input?.questions ?? []).map((question) => {
      const key = questionKey(question);
      const answer = answers && key in answers ? answers[key] : undefined;
      const resolved = answer === undefined ? null : resolveAnswer(question, answer);
      const chosen = new Set(resolved?.chosen ?? []);
      return { key, question, resolved, others: question.options.filter((option) => !chosen.has(option)) };
    }),
  );
</script>

<!-- One row grammar for every option, chosen or not, so an opened list reads
     as the list the user picked from: the pick carries the check, the rest an
     empty ring and muted text. -->
{#snippet optionRow(option: QuestionOption, chosen: boolean)}
  {@const label = optionLabelParts(option.label)}
  <div
    class="flex items-start gap-2.5 rounded-lg border px-[0.6875rem] py-[0.5rem] pointer-fine:[.is-laptop-display_&]:gap-2 pointer-fine:[.is-laptop-display_&]:rounded-md pointer-fine:[.is-laptop-display_&]:px-2.5 pointer-fine:[.is-laptop-display_&]:py-[0.375rem] {chosen ? 'border-border bg-card' : 'border-(--solus-tx-rule-strong) bg-transparent'}"
  >
    {#if chosen}
      <span class="mt-[0.1875rem] inline-flex size-[0.9375rem] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--chart-3)_18%,transparent)] text-[color-mix(in_oklch,var(--chart-3)_70%,var(--foreground))] pointer-fine:[.is-laptop-display_&]:size-[0.8125rem]" aria-hidden="true">
        <Check size="0.625rem" strokeWidth={3} />
      </span>
    {:else}
      <span class="mt-[0.1875rem] inline-flex size-[0.9375rem] shrink-0 rounded-full border border-border pointer-fine:[.is-laptop-display_&]:size-[0.8125rem]" aria-hidden="true"></span>
    {/if}
    <span class="flex min-w-0 flex-1 flex-col gap-px">
      <span class="break-words {chosen ? 'font-medium' : 'text-(--muted-foreground)'}">{label.text}{#if label.note}<span class="ml-1 text-transcript-meta font-normal text-(--muted-foreground)">· {label.note}</span>{/if}</span>
      {#if option.description}
        <span class="text-transcript-meta leading-[1.5] text-pretty text-(--muted-foreground) {chosen ? '' : 'opacity-80'}">{option.description}</span>
      {/if}
    </span>
  </div>
{/snippet}

<!-- The resolved twin of QuestionCard: same option-row grammar for the choice
     the user made, flush on the canvas because it is history, not an interrupt. -->
<section
  class="my-2 min-w-0 py-1 text-transcript-card"
  aria-label="Question and answer"
  data-testid="answered-question"
  data-conversation-message-id={message.id}
>
  <div class="flex items-start gap-[0.75em]">
    <MessageCircle size="1em" class="mt-[0.3125em] shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 items-center gap-2">
        <span class="text-transcript-meta font-medium uppercase text-(--muted-foreground)">Question</span>
        {#if hasAnswers}
          <TranscriptChip state="positive">Answered</TranscriptChip>
        {:else if message.questionResult}
          <TranscriptChip>Answered</TranscriptChip>
        {:else if message.toolStatus === 'error'}
          <TranscriptChip state="destructive">Did not complete</TranscriptChip>
        {:else}
          <TranscriptChip>No answer recorded</TranscriptChip>
        {/if}
      </div>

      <div class="mt-1.5 flex flex-col gap-3.5 pointer-fine:[.is-laptop-display_&]:gap-3">
        {#each questions as { key, question, resolved, others }, i (key)}
          <div class="flex min-w-0 flex-col gap-1.5 pointer-fine:[.is-laptop-display_&]:gap-1">
            <p class="m-0 leading-relaxed text-pretty break-words whitespace-pre-wrap text-foreground">
              {#if questions.length > 1}<span class="mr-1.5 text-transcript-meta text-(--muted-foreground) opacity-70">{i + 1}.</span>{/if}{question.question}
            </p>

            {#if resolved}
              {#if resolved.deferred}
                <p class="m-0 text-transcript-meta text-(--muted-foreground)">
                  <span class="sr-only">You answered: </span>Left to the agent
                </p>
              {:else}
                <span class="sr-only">You answered:</span>
                <div class="flex min-w-0 flex-col gap-1">
                  {#each resolved.chosen as option (option.label)}
                    {@render optionRow(option, true)}
                  {/each}
                  {#if resolved.remark}
                    <div class="flex items-start gap-2.5 px-[0.6875rem] py-1 pointer-fine:[.is-laptop-display_&]:gap-2 pointer-fine:[.is-laptop-display_&]:px-2.5">
                      <MessageSquareText size="0.9375rem" class="mt-[0.1875rem] shrink-0 text-(--muted-foreground)" aria-hidden="true" />
                      <p class="m-0 min-w-0 leading-relaxed break-words whitespace-pre-wrap text-foreground">{resolved.remark}</p>
                    </div>
                  {/if}
                </div>
              {/if}

              <!-- Opening the disclosure completes the list the user chose from:
                   the pick keeps its check, the rest appear beneath it unmarked. -->
              {#if others.length}
                <details class="group">
                  <summary class="-ml-1 flex min-h-7 w-fit cursor-pointer list-none items-center gap-1 rounded px-1 text-transcript-meta text-(--muted-foreground) outline-none transition-colors select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-fine:[.is-laptop-display_&]:min-h-6">
                    <ChevronRight size="1em" class="shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
                    <span class="group-open:hidden">Show {others.length} other {others.length === 1 ? 'option' : 'options'}</span>
                    <span class="hidden group-open:inline">Hide other options</span>
                  </summary>
                  <div class="mt-0.5 flex min-w-0 flex-col gap-1">
                    {#each others as option (option.label)}
                      {@render optionRow(option, false)}
                    {/each}
                  </div>
                </details>
              {/if}
            {/if}
          </div>
        {:else}
          <p class="m-0 text-(--muted-foreground)">Agent question</p>
        {/each}

        {#if !hasAnswers}
          {#if message.questionResult}
            <!-- No structured answer survived, so the transcript's own record of
                 it is the answer. -->
            <div class="flex min-w-0 flex-col gap-1">
              <span class="text-transcript-meta text-(--muted-foreground)">Answer, from the transcript</span>
              <p class="m-0 rounded-lg border border-border bg-card px-[0.6875rem] py-[0.5rem] leading-relaxed break-words whitespace-pre-wrap pointer-fine:[.is-laptop-display_&]:rounded-md pointer-fine:[.is-laptop-display_&]:px-2.5 pointer-fine:[.is-laptop-display_&]:py-[0.375rem]">{message.questionResult}</p>
            </div>
          {:else}
            <p class="m-0 text-transcript-meta text-(--muted-foreground)">
              {message.toolStatus === 'error' ? 'The question did not complete.' : 'The answer is not in this transcript.'}
            </p>
          {/if}
        {/if}
      </div>
    </div>
  </div>
</section>
