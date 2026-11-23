<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import { plainDetail, type AgentLinkStatus } from "./lib/agent-link";
  import { subagentDetail } from "./lib/subagent-card";
  import type { SubagentRow } from "./lib/subagent-group";
  import AgentLinkRow from "./AgentLinkRow.svelte";

  /** One sub-agent as a flat row. A click opens its transcript in the pane. */
  interface Props {
    row: SubagentRow;
    tabId: string;
    link: AgentLinkStatus;
    elapsed: string;
  }
  let { row, tabId, link, elapsed }: Props = $props();

  const session = getWorkspaceContext();
  const router = session.router;

  const isOpen = $derived(
    router.companionSurface?.name === "subagent" && router.companionSurface.params.messageId === row.id,
  );
</script>

<AgentLinkRow
  provider={row.provider}
  {link}
  title={row.name}
  detail={plainDetail(subagentDetail(row))}
  hint={[row.modelLabel, row.effortLabel].filter(Boolean).join(" · ")}
  {elapsed}
  open={isOpen}
  ariaLabel={`Open ${row.name}`}
  data-testid="subagent-card"
  data-state={link.standing}
  onOpen={() => session.openSubagent(tabId, row.id)}
/>
