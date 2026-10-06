<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import { formatActivityDuration } from "./lib/activity-summary";
  import { plainDetail, subagentLinkStatus } from "./lib/agent-link";
  import { subagentDetail } from "./lib/subagent-card";
  import type { SubagentRow } from "./lib/subagent-group";
  import AgentLinkRow from "./AgentLinkRow.svelte";

  /** One sub-agent as a flat row. A click opens its transcript in the pane. */
  interface Props {
    row: SubagentRow;
    tabId: string;
  }
  let { row, tabId }: Props = $props();

  const session = getWorkspaceContext();
  const router = session.router;

  const status = $derived(subagentLinkStatus(row.state));
  const isOpen = $derived(
    router.companionSurface?.name === "subagent" && router.companionSurface.params.messageId === row.id,
  );
</script>

<AgentLinkRow
  provider={row.provider}
  tone={status.tone}
  title={row.name}
  status={status.label}
  detail={plainDetail(subagentDetail(row))}
  hint={[row.modelLabel, row.effortLabel].filter(Boolean).join(" · ")}
  elapsed={formatActivityDuration(row.elapsedMs)}
  open={isOpen}
  ariaLabel={`Open ${row.name}`}
  data-testid="subagent-card"
  data-state={row.state}
  onOpen={() => session.openSubagent(tabId, row.id)}
/>
