<script lang="ts">
  /** The private card of `request_secret` (docs/plans/webhooks.md §3.6). The
   *  value lives only in this card's local state: it is never echoed, never kept
   *  in a draft or in the transcript, and it goes to the host once through
   *  `secretRequestAnswer`. The host closes the card with `permission_resolved`. */
  import { KeyRound as KeyIcon } from "@lucide/svelte";
  import type { QuestionRequest } from "@solus/contracts/types";
  import { getWorkspaceContext } from "../../contexts";
  import { canDriveSession } from "../../contexts/sharing/resource-roles";
  import { runHost } from "../../contexts/workspace/run-location";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import InterruptCard from "./InterruptCard.svelte";
  import { canSubmitSecret, secretRequestPrompt } from "./lib/secret-request";

  interface Props {
    tabId: string;
    request: QuestionRequest;
    /** Answers for another session's card. Unset, the answer goes to this tab's session. */
    answer?: (questionId: string, value: string | null) => Promise<boolean>;
  }
  let { tabId, request, answer }: Props = $props();

  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(tabId));
  const canDrive = $derived(canDriveSession(runHost(sess?.run), sess?.id, "drive.approve"));
  const prompt = $derived(secretRequestPrompt(request));

  let value = $state("");
  let isSending = $state(false);
  let responded = $state(false);
  const closed = $derived(responded || !!request.expired);

  async function send(secret: string | null) {
    if (isSending || closed) return;
    isSending = true;
    try {
      const ctx = session.ctxFor(tabId);
      const accepted = answer
        ? await answer(request.questionId, secret)
        : await session.apiFor(tabId).secretRequestAnswer(ctx.session.sessionId, request.questionId, secret);
      if (!accepted) {
        toasts.error("This request is no longer open");
        return;
      }
      responded = true;
      requestInputFocus();
    } catch (error) {
      toasts.error("Could not send the answer", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      // The value is not kept after a send, also after a failed send.
      value = "";
      isSending = false;
    }
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (canSubmitSecret(value)) void send(value);
  }
</script>

<InterruptCard type="question" title="Secret requested" target={prompt.name} testId="secret-request-card">
  <div class="flex flex-col gap-2">
    <p class="m-0 text-transcript-card">{prompt.reason}</p>
    <p class="m-0 flex items-center gap-1.5 text-transcript-meta text-(--muted-foreground)">
      <KeyIcon size={14} class="shrink-0" />
      The value goes only to the host. The agent and the transcript never see it.
    </p>
    {#if request.expired}
      <p class="m-0 text-transcript-meta text-(--muted-foreground)">This request is closed.</p>
    {:else}
      <form id="secret-request-{request.questionId}" onsubmit={submit}>
        <Input
          bind:value
          type="password"
          autocomplete="off"
          spellcheck={false}
          disabled={closed || isSending || !canDrive}
          aria-label="Value of {prompt.name}"
          class="font-mono"
        />
      </form>
    {/if}
  </div>
  {#snippet footer()}
    {#if !request.expired}
      <Button size="sm" variant="ghost" disabled={closed || isSending || !canDrive} onclick={() => void send(null)}>Decline</Button>
      <Button
        size="sm"
        type="submit"
        form="secret-request-{request.questionId}"
        disabled={closed || isSending || !canDrive || !canSubmitSecret(value)}
      >
        Submit
      </Button>
    {/if}
  {/snippet}
</InterruptCard>
