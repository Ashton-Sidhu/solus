<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import { sessionPullRequestsStore } from "../../contexts/prs/session-pull-requests.store.svelte";
  import { taskBindingSessionId } from "../../contexts/workspace/session-draft.svelte";
  import { sessionTitle } from "../../lib/sessionUtils";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { Input } from "../ui/input";
  import { Button } from "../ui/button";
  import { checkPullRequestUrl, taskPullRequestLink } from "./lib/link-pull-request";

  /**
   * Link a pull request by its URL, to a session or to a task. A session owns
   * its link and its task reads it; a link on a task is for a pull request
   * that no session of the task made (docs/plans/session-pull-requests.md).
   */
  interface Props {
    owner: { kind: "session"; tabId: string } | { kind: "task"; taskId: string };
    onClose: () => void;
  }

  let { owner, onClose }: Props = $props();

  const session = getWorkspaceContext();
  const sess = $derived(owner.kind === "session" ? session.sessionFor(owner.tabId) : null);
  const task = $derived(owner.kind === "task" ? session.tasksStore.peek(owner.taskId) : null);
  const ownerLabel = $derived(
    owner.kind === "session" ? (sess ? sessionTitle(sess) : "Session") : (task?.title ?? "Task"),
  );

  let value = $state("");
  let saving = $state(false);
  const check = $derived(checkPullRequestUrl(value));

  function close(): void {
    onClose();
    requestInputFocus();
  }

  async function save(): Promise<void> {
    if (check.kind !== "valid" || saving) return;
    saving = true;
    try {
      if (owner.kind === "session") {
        const sessionId = sess ? taskBindingSessionId(sess) : null;
        if (!sessionId) throw new Error("The session is not available.");
        await sessionPullRequestsStore.link(session.serverIdFor(owner.tabId), sessionId, check.url);
      } else {
        const link = taskPullRequestLink(check.url);
        if (!link) throw new Error("The URL is not a pull request.");
        await session.tasksStore.get(owner.taskId).link(link);
      }
      close();
    } catch (error) {
      toasts.error("Couldn't link the pull request", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      saving = false;
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  data-solus-ui
  class="pointer-events-auto fixed inset-0 z-[10008] flex items-start justify-center bg-transparent pt-[18vh]"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) close();
  }}
  onkeydown={(e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  }}
>
  <div
    class="flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-3 rounded-2xl border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) p-[1.125rem] text-workspace-chrome shadow-[var(--solus-popover-shadow)]"
    role="dialog"
    aria-label="Link pull request"
    aria-modal="true"
  >
    <div class="flex flex-col gap-1">
      <span class="font-medium">Link pull request</span>
      <span class="truncate text-xs text-(--solus-text-tertiary)">
        {owner.kind === "session" ? "To session" : "To task"}: {ownerLabel}
      </span>
    </div>
    <Input
      bind:value
      autofocus
      placeholder="https://github.com/owner/repo/pull/123"
      aria-label="Pull request URL"
      aria-invalid={check.kind === "invalid"}
      onSubmit={() => void save()}
      submitOn="enter"
    />
    <span class="min-h-4 text-xs {check.kind === 'invalid' ? 'text-(--failure)' : 'text-(--solus-text-tertiary)'}">
      {#if check.kind === "invalid"}
        Paste the full URL of a GitHub pull request.
      {:else if check.kind === "valid"}
        {check.label}
      {/if}
    </span>
    <div class="flex justify-end gap-2">
      <Button variant="ghost" size="sm" onclick={close}>Cancel</Button>
      <Button size="sm" disabled={check.kind !== "valid" || saving} onclick={() => void save()}>
        {saving ? "Linking…" : "Link"}
      </Button>
    </div>
  </div>
</div>
