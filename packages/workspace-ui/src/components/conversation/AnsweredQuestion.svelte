<script lang="ts">
  import { MessageCircle, ChevronRight, CornerDownRight } from '@lucide/svelte';
  import type { Message } from '@solus/contracts/types';
  import { questionKey } from '@solus/contracts/question-answer';
  import { parseQuestionInput } from '@solus/contracts/question-history';

  let { message }: { message: Message } = $props();
  const input = $derived(message.questionAnswer ?? parseQuestionInput(message.toolInput));
</script>

<section
  class="my-2 min-w-0 py-2 text-transcript-card"
  aria-label="Question and answer"
  data-testid="answered-question"
  data-conversation-message-id={message.id}
>
  <div class="flex items-start gap-[0.75em]">
    <MessageCircle size="1em" class="mt-[0.25em] shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
    <div class="min-w-0 flex-1 space-y-[0.75em]">
      {#each input?.questions ?? [] as question}
        <div>
          <p class="leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">{question.question}</p>
          {#if input?.answers && questionKey(question) in input.answers}
            <div class="mt-1 flex items-start gap-2">
              <CornerDownRight size="1em" class="mt-[0.25em] shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
              <p class="min-w-0 leading-relaxed whitespace-pre-wrap break-words text-foreground"><span class="sr-only">You answered: </span>{input.answers[questionKey(question)] || 'Let the agent decide'}</p>
            </div>
          {/if}
        </div>
      {:else}
        <p class="text-muted-foreground">Agent question</p>
      {/each}
      {#if !input?.answers && !message.questionResult}
        <p class="mt-1 text-muted-foreground">{message.toolStatus === 'error' ? 'Question did not complete.' : 'Answer not available in this transcript.'}</p>
      {/if}
      {#if message.questionResult || input?.questions.some((question) => question.options.length > 0)}
        <details class="group">
          <summary class="-ml-1 flex min-h-7 w-fit cursor-pointer list-none items-center gap-1 rounded px-1 text-workspace-chrome text-(--solus-text-tertiary) outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight size="1em" class="group-open:rotate-90" aria-hidden="true" />
            Details
          </summary>
          <div class="mt-1 space-y-3 border-l border-(--solus-tx-rule-strong) py-1 pl-4">
            {#each input?.questions ?? [] as question}
              {#if question.options.length}
                {#if (input?.questions.length ?? 0) > 1}<p class="font-medium">{question.question}</p>{/if}
                <ul class="space-y-1.5">
                  {#each question.options as option}
                    <li class="break-words"><span class="font-medium">{option.label}</span>{#if option.description}<span class="text-muted-foreground"> — {option.description}</span>{/if}</li>
                  {/each}
                </ul>
              {/if}
            {/each}
            {#if message.questionResult}
              <div>
                <p class="mb-1 text-workspace-chrome text-muted-foreground">Answer details from transcript (excerpt)</p>
                <p class="whitespace-pre-wrap break-words">{message.questionResult}</p>
              </div>
            {/if}
          </div>
        </details>
      {/if}
    </div>
  </div>
</section>
