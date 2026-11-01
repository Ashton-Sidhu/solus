<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";

  /**
   * The link prompts that a row's menu opens (`WorkspaceUiStore.linkPrompt`).
   * Each client mounts this once, so desktop, web and phone open the same
   * dialogs.
   */
  const session = getWorkspaceContext();
  const prompt = $derived(session.ui.linkPrompt);
  const close = () => (session.ui.linkPrompt = null);
</script>

<!-- Each dialog loads when a menu first opens it. -->
{#if prompt?.kind === "session-task" && session.tabs[prompt.tabId]}
  {@const tabId = prompt.tabId}
  {#await import("./LinkSessionTaskDialog.svelte") then { default: LinkSessionTaskDialog }}
    <LinkSessionTaskDialog {tabId} onClose={close} />
  {/await}
{:else if prompt?.kind === "session-pull-request" && session.tabs[prompt.tabId]}
  {@const tabId = prompt.tabId}
  {#await import("./LinkPullRequestDialog.svelte") then { default: LinkPullRequestDialog }}
    <LinkPullRequestDialog owner={{ kind: "session", tabId }} onClose={close} />
  {/await}
{:else if prompt?.kind === "task-pull-request"}
  {@const taskId = prompt.taskId}
  {#await import("./LinkPullRequestDialog.svelte") then { default: LinkPullRequestDialog }}
    <LinkPullRequestDialog owner={{ kind: "task", taskId }} onClose={close} />
  {/await}
{/if}
