<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import { Square as SquareIcon } from "@lucide/svelte";
  import TranscriptCard from "./TranscriptCard.svelte";

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
  const isOpen = $derived(session.router.params("task")?.taskId === ref.taskId);

  function open() {
    session.goToTask(ref.taskId);
  }
</script>

<TranscriptCard
  title={ref.title}
  type="task"
  actionLabel="Open"
  ariaLabel={`Open task: ${ref.title}`}
  onOpen={open}
  open={isOpen}
  {skipMotion}
>
  {#snippet glyph()}<SquareIcon />{/snippet}
  {#snippet rail()}{ref.taskId}{/snippet}
</TranscriptCard>
