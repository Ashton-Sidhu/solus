<script lang="ts">
  /**
   * The tools of one MCP server, each with its access and a switch that keeps it
   * on or turns it off for agents (docs/integrations.md). Shared by the connect
   * dialog, which keeps a draft, and the server's row, which saves each change.
   */
  import { toolAccess, type IntegrationToolSummary } from "@solus/contracts/integration-types";
  import * as Table from "../ui/table";
  import { Switch } from "../ui/switch";
  import { firstLine } from "./lib/integration-labels";

  interface Props {
    integrationName: string;
    tools: IntegrationToolSummary[];
    /** The names of the tools that are off. */
    disabledTools: ReadonlySet<string>;
    isDisabled?: boolean;
    onToggle: (toolName: string, isOn: boolean) => void;
  }

  let { integrationName, tools, disabledTools, isDisabled = false, onToggle }: Props = $props();
</script>

<!-- A long list scrolls inside its card, so the actions below it stay in view. -->
<Table.Root containerClass="max-h-80 overflow-y-auto" class="table-fixed" aria-label="Tools of {integrationName}">
  <Table.Body>
    {#each tools as tool (tool.name)}
      {@const access = toolAccess(tool)}
      {@const label = tool.title || tool.name}
      <Table.Row>
        <Table.Cell class="pointer-coarse:h-11">
          <span class="block truncate text-workspace-chrome text-foreground" title={tool.name}>{label}</span>
          {#if firstLine(tool.description)}
            <span class="block truncate text-chrome-dense text-(--solus-text-secondary)" title={tool.description}>{firstLine(tool.description)}</span>
          {/if}
        </Table.Cell>
        <Table.Cell class="w-28 px-0 text-end">
          <span class="rounded-md px-1.5 py-0.5 text-chrome-dense {access === 'Read'
            ? 'bg-muted text-(--solus-text-secondary)'
            : access === 'Write'
              ? 'bg-(--solus-accent-soft) text-(--solus-accent)'
              : 'bg-(--solus-status-error-bg) text-(--solus-status-error)'}">{access}</span>
        </Table.Cell>
        <Table.Cell class="w-16 text-end">
          <Switch
            bind:checked={() => !disabledTools.has(tool.name), (isOn) => onToggle(tool.name, isOn)}
            disabled={isDisabled}
            aria-label="Let agents use {label}"
          />
        </Table.Cell>
      </Table.Row>
    {/each}
  </Table.Body>
</Table.Root>
