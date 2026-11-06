<script lang="ts">
  /** The private card of `request_secret` (docs/plans/webhooks.md §3.6): one
   *  field per secret; the user saves or declines each one. A `file` secret is
   *  saved where the agent's commands can read it, and the card says so. The values live only
   *  in this card's local state: they are never echoed, never kept in a draft or
   *  in the transcript, and they go to the host once through
   *  `secretRequestAnswer`. The host closes the card with `permission_resolved`. */
  import { LockKeyhole as LockIcon, SquareTerminal as TerminalIcon } from "@lucide/svelte";
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
  import { canSubmitSecrets, SECRET_PLACEHOLDER, secretAnswer, secretPrivacyNote, secretRequestPrompts, type SecretField } from "@solus/contracts/secret-request";

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
  title={isGroup ? `${prompts.length} secrets requested` : "Secret requested"}
  testId="secret-request-card"
>
  {#if request.expired}
    <p class="m-0 text-transcript-meta text-(--muted-foreground)">This request is closed.</p>
  {:else}
    <form id="secret-request-{request.questionId}" class="flex flex-col gap-3" autocomplete="off" onsubmit={submit}>
      {#each prompts as prompt, index (index)}
        {@const field = fields[index]}
        {@const inputId = `secret-request-${request.questionId}-${index}`}
        {#if index > 0}
          <div class="h-px bg-(--border) opacity-60"></div>
        {/if}
        <div class="flex min-w-0 flex-col gap-2">
          <div class="flex min-w-0 flex-col gap-0.5">
            <label for={inputId} class="text-transcript-card font-medium">{prompt.name}</label>
            <p class="m-0 text-transcript-meta text-(--muted-foreground) wrap-anywhere">{prompt.reason}</p>
          </div>
          {#if field.isDeclined}
            <div class="flex min-w-0 items-center justify-between gap-2">
              <p class="m-0 text-transcript-meta text-(--muted-foreground)">Declined. The agent does not get this secret.</p>
              <Button
                size="xs"
                variant="ghost"
                class="text-(--muted-foreground)"
                disabled={closed || isSending || !canDrive}
                aria-label="Undo decline of {prompt.name}"
                onclick={() => toggleDeclined(field)}
              >
                Undo
              </Button>
            </div>
          {:else}
            <div class="flex min-w-0 items-center gap-2">
              <Input
                id={inputId}
                bind:value={field.value}
                type="password"
                autocomplete="off"
                spellcheck={false}
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                placeholder={SECRET_PLACEHOLDER}
                disabled={closed || isSending || !canDrive}
                aria-describedby="{inputId}-note"
                class="min-w-0 flex-1"
              />
              {#if !isGroup}
                <Button type="submit" disabled={closed || isSending || !canDrive || !canSubmitSecrets(fields)}>Save securely</Button>
              {/if}
            </div>
            <div class="flex min-w-0 items-center justify-between gap-2">
              <p id="{inputId}-note" class="m-0 flex min-w-0 items-center gap-1.5 text-transcript-meta text-(--muted-foreground)">
                {#if prompt.delivery === "file"}
                  <TerminalIcon size={14} class="shrink-0" />
                {:else}
                  <LockIcon size={14} class="shrink-0" />
                {/if}
                {secretPrivacyNote(prompt)}
              </p>
              <Button
                size="xs"
                variant="ghost"
                class="shrink-0 text-(--muted-foreground)"
                disabled={closed || isSending || !canDrive}
                aria-label="Decline {prompt.name}"
                onclick={() => (isGroup ? toggleDeclined(field) : void send([null]))}
              >
                Decline
              </Button>
            </div>
          {/if}
        </div>
      {/each}
    </form>
  {/if}
  {#snippet footer()}
    {#if !request.expired && isGroup}
      <div class="flex items-center justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={closed || isSending || !canDrive}
          onclick={() => void send(fields.map(() => null))}
        >
          Decline all
        </Button>
        <Button
          size="sm"
          type="submit"
          form="secret-request-{request.questionId}"
          disabled={closed || isSending || !canDrive || !canSubmitSecrets(fields)}
        >
          Save securely
        </Button>
      </div>
    {/if}
  {/snippet}
</InterruptCard>
