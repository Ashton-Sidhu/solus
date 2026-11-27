<script lang="ts">
  /**
   * The tools of one MCP server, each with its access and a switch that keeps it
   * on or turns it off for agents (docs/integrations.md). Shared by the connect
   * dialog, which keeps a draft, and the server's row, which saves each change.
   */
  import { toolAccess, type IntegrationToolSummary } from "@solus/contracts/integration-types";
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

<!-- A long list scrolls inside its card, so the actions below it stay in view.
     Two columns once its own box has room: the server card is wide, the connect dialog is not.
     It never scrolls sideways: each switch's hit area reaches past its right edge. -->
<div class="@container/tools max-h-80 overflow-x-hidden overflow-y-auto">
  <ul class="grid grid-cols-1 gap-x-10 @min-[40rem]/tools:grid-cols-2" aria-label="Tools of {integrationName}">
    {#each tools as tool (tool.name)}
      {@const access = toolAccess(tool)}
      {@const label = tool.title || tool.name}
      <li class="flex min-w-0 items-center gap-3 py-2 pointer-coarse:min-h-11">
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-1.5">
            <span class="truncate text-workspace-chrome leading-5 text-foreground" title={tool.name}>{label}</span>
            <span class="shrink-0 rounded-md px-1.5 text-chrome-dense leading-5 {access === 'Read'
              ? 'bg-muted text-(--solus-text-secondary)'
              : access === 'Write'
                ? 'bg-(--solus-accent-soft) text-(--solus-accent)'
                : 'bg-(--solus-status-error-bg) text-(--solus-status-error)'}">{access}</span>
          </div>
          {#if firstLine(tool.description)}
            <span class="block truncate text-chrome-dense leading-5 text-muted-foreground" title={tool.description}>{firstLine(tool.description)}</span>
          {/if}
        </div>
        <Switch
          bind:checked={() => !disabledTools.has(tool.name), (isOn) => onToggle(tool.name, isOn)}
          disabled={isDisabled}
          aria-label="Let agents use {label}"
        />
      </li>
    {/each}
  </ul>
</div>
