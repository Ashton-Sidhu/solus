<script lang="ts">
  /** The private card of `request_secret` (docs/plans/webhooks.md §3.6): one
   *  field per secret; the user saves or declines each one. The values live only
   *  in this card's local state: they are never echoed, never kept in a draft or
   *  in the transcript, and they go to the host once through
   *  `secretRequestAnswer`. The host closes the card with `permission_resolved`. */
  import { KeyRound as KeyIcon } from "@lucide/svelte";
  import type { QuestionRequest } from "@solus/contracts/types";
  import { untrack } from "svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { canDriveSession } from "../../contexts/sharing/resource-roles";
  import { runHost } from "../../contexts/workspace/run-location";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import InterruptCard from "./InterruptCard.svelte";
  import { canSubmitSecrets, secretAnswer, secretRequestPrompts, type SecretField } from "@solus/contracts/secret-request";

  interface Props {
    tabId: string;
    request: QuestionRequest;
    /** Answers for another session's card. Unset, the answer goes to this tab's session. */
    answer?: (questionId: string, values: (string | null)[]) => Promise<boolean>;
  }
  let { tabId, request, answer }: Props = $props();

  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(tabId));
  const canDrive = $derived(canDriveSession(runHost(sess?.run), sess?.id, "drive.approve"));
  const prompts = $derived(secretRequestPrompts(request));
  const isGroup = $derived(prompts.length > 1);

  // One field per secret. Callers key the card by request, so it is set once.
  let fields = $state<SecretField[]>(untrack(() => prompts.map(() => ({ value: "", isDeclined: false }))));
  let isSending = $state(false);
  let responded = $state(false);
  const closed = $derived(responded || !!request.expired);

  async function send(values: (string | null)[]) {
    if (isSending || closed) return;
    isSending = true;
    try {
      const ctx = session.ctxFor(tabId);
      const accepted = answer
        ? await answer(request.questionId, values)
        : await session.apiFor(tabId).secretRequestAnswer(ctx.session.sessionId, request.questionId, values);
      if (!accepted) {
        toasts.error("This request is no longer open");
        return;
      }
      responded = true;
      requestInputFocus();
    } catch (error) {
      toasts.error("Could not send the answer", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      // No value is kept after a send, also after a failed send.
      for (const field of fields) field.value = "";
      isSending = false;
    }
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (canSubmitSecrets(fields)) void send(secretAnswer(fields));
  }

  function toggleDeclined(field: SecretField) {
    field.isDeclined = !field.isDeclined;
    // A declined secret keeps no value.
    field.value = "";
  }
</script>

<InterruptCard
  type="question"
  title={isGroup ? `${prompts.length} secrets requested` : `Secret requested · ${prompts[0].name}`}
  testId="secret-request-card"
>
  <div class="flex flex-col gap-2">
    {#if !isGroup}
      <p class="m-0 text-transcript-card">{prompts[0].reason}</p>
    {/if}
    <p class="m-0 flex items-center gap-1.5 text-transcript-meta text-(--muted-foreground)">
      <KeyIcon size={14} class="shrink-0" />
      The {isGroup ? "values go" : "value goes"} only to the host. The agent and the transcript never see {isGroup ? "them" : "it"}.
    </p>
    {#if request.expired}
      <p class="m-0 text-transcript-meta text-(--muted-foreground)">This request is closed.</p>
    {:else}
      <form id="secret-request-{request.questionId}" class="flex flex-col gap-3" onsubmit={submit}>
        {#each prompts as prompt, index (index)}
          {@const field = fields[index]}
          {#if isGroup}
            <div class="flex flex-col gap-1.5">
              <div class="flex items-start justify-between gap-2">
                <div class="flex min-w-0 flex-col gap-0.5">
                  <span class="text-transcript-card font-medium">{prompt.name}</span>
                  <span class="text-transcript-meta text-(--muted-foreground)">{prompt.reason}</span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={closed || isSending || !canDrive}
                  aria-pressed={field.isDeclined}
                  aria-label="{field.isDeclined ? 'Undo decline of' : 'Decline'} {prompt.name}"
                  onclick={() => toggleDeclined(field)}
                >
                  {field.isDeclined ? "Undo" : "Decline"}
                </Button>
              </div>
              {#if field.isDeclined}
                <p class="m-0 text-transcript-meta text-(--muted-foreground)">Declined. The agent does not get this secret.</p>
              {:else}
                <Input
                  bind:value={field.value}
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  disabled={closed || isSending || !canDrive}
                  aria-label="Value of {prompt.name}"
                  class="font-mono"
                />
              {/if}
            </div>
          {:else}
            <Input
              bind:value={field.value}
              type="password"
              autocomplete="off"
              spellcheck={false}
              disabled={closed || isSending || !canDrive}
              aria-label="Value of {prompt.name}"
              class="font-mono"
            />
          {/if}
        {/each}
      </form>
    {/if}
  </div>
  {#snippet footer()}
    {#if !request.expired}
      <div class="flex items-center justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={closed || isSending || !canDrive}
          onclick={() => void send(fields.map(() => null))}
        >
          {isGroup ? "Decline all" : "Decline"}
        </Button>
        <Button
          size="sm"
          type="submit"
          form="secret-request-{request.questionId}"
          disabled={closed || isSending || !canDrive || !canSubmitSecrets(fields)}
        >
          Submit
        </Button>
      </div>
    {/if}
  {/snippet}
</InterruptCard>
