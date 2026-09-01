<script lang="ts">
  import { ChatCircleDotsIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { agentLabel } from "../../lib/agentAvailability";
  import ConversationRefCard from "./ConversationRefCard.svelte";
  import type { AgentId } from "../../../shared/types";

  interface Props {
    ref: {
      agentSessionId: string;
      title: string;
      provider: AgentId;
      cwd: string;
      verb?: "Started" | "Prompted" | "Stopped";
    };
    skipMotion?: boolean;
  }
  let { ref, skipMotion = false }: Props = $props();

  const session = getWorkspaceContext();

  function open() {
    void session.resumeSession({
      provider: ref.provider,
      sessionId: ref.agentSessionId,
      slug: null,
      firstMessage: ref.title,
      lastTimestamp: new Date().toISOString(),
      size: 0,
      cwd: ref.cwd,
      projectPath: ref.cwd,
    });
  }
</script>

<ConversationRefCard
  title={ref.title}
  subtitle={`${ref.verb ?? "Started"} · ${agentLabel(ref.provider)}`}
  ariaLabel={`Open session: ${ref.title}`}
  onOpen={open}
  {skipMotion}
>
  {#snippet icon()}
    <span style:color="var(--solus-accent)">
      <ChatCircleDotsIcon size={18} weight="regular" />
    </span>
  {/snippet}
</ConversationRefCard>
