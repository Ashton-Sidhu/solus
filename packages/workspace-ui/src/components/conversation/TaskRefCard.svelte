<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
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
    session.goToTask(ref.taskId);
  }
</script>

<ConversationRefCard
  kicker="Task"
  title={ref.title}
  subtitle={ref.taskId}
  ariaLabel={`Open task: ${ref.title}`}
  onOpen={open}
  {skipMotion}
/>
