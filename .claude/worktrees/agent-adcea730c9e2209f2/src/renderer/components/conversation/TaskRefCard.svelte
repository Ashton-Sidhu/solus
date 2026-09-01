<script lang="ts">
  import { CheckSquareOffsetIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import ConversationRefCard from "./ConversationRefCard.svelte";

  interface Props {
    ref: {
      taskId: string;
      title: string;
      url: string | null;
    };
    skipMotion?: boolean;
  }

  let { ref, skipMotion = false }: Props = $props();
  const session = getWorkspaceContext();

  function open() {
    session.ui.openTasksToTask(ref.taskId);
  }
</script>

<ConversationRefCard
  title={ref.title}
  subtitle={`Task ${ref.taskId}`}
  ariaLabel={`Open task: ${ref.title}`}
  onOpen={open}
  {skipMotion}
>
  {#snippet icon()}
    <span style:color="var(--solus-accent)">
      <CheckSquareOffsetIcon size={18} weight="regular" />
    </span>
  {/snippet}
</ConversationRefCard>
