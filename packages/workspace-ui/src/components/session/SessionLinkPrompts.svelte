<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import LinkPullRequestDialog from "./LinkPullRequestDialog.svelte";
  import LinkSessionTaskDialog from "./LinkSessionTaskDialog.svelte";

  /**
   * The link prompts that a row's menu opens (`WorkspaceUiStore.linkPrompt`).
   * Each client mounts this once, so desktop, web and phone open the same
   * dialogs.
   */
  const session = getWorkspaceContext();
  const prompt = $derived(session.ui.linkPrompt);
  const close = () => (session.ui.linkPrompt = null);
</script>

{#if prompt?.kind === "session-task" && session.tabs[prompt.tabId]}
  <LinkSessionTaskDialog tabId={prompt.tabId} onClose={close} />
{:else if prompt?.kind === "session-pull-request" && session.tabs[prompt.tabId]}
  <LinkPullRequestDialog owner={{ kind: "session", tabId: prompt.tabId }} onClose={close} />
{:else if prompt?.kind === "task-pull-request"}
  <LinkPullRequestDialog owner={{ kind: "task", taskId: prompt.taskId }} onClose={close} />
{/if}
