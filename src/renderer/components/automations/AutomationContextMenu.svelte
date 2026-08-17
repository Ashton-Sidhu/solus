<script lang="ts">
  import {
    CopyIcon,
    PauseIcon,
    PencilSimpleIcon,
    PlayIcon,
    StarIcon,
    StopIcon,
    TrashIcon,
  } from "phosphor-svelte";
  import type { Automation } from "../../../shared/types";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import * as ContextMenu from "../ui/context-menu";

  let {
    x,
    y,
    automation,
    onEdit,
    onRunNow,
    onCancelRun,
    onToggleEnabled,
    onToggleFavorite,
    onDelete,
    onClose,
  }: {
    x: number;
    y: number;
    automation: Automation;
    onEdit: () => void;
    onRunNow: () => void;
    onCancelRun: () => void;
    onToggleEnabled: () => void;
    onToggleFavorite: () => void;
    onDelete: () => void;
    onClose: () => void;
  } = $props();

  function select(action: () => void) {
    action();
    onClose();
  }

  async function copyId() {
    onClose();
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(automation.id);
      else {
        const textarea = document.createElement("textarea");
        textarea.value = automation.id;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      toasts.success("Automation ID copied");
    } catch {
      toasts.error("Couldn't copy automation ID");
    }
    requestInputFocus();
  }
</script>

<ContextMenu.Root onOpenChange={(open) => { if (!open) onClose(); }}>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content class="min-w-48">
    <ContextMenu.Item onSelect={() => select(onEdit)}>
      <PencilSimpleIcon />
      Edit automation
    </ContextMenu.Item>
    {#if automation.lastRunStatus === "running"}
      <ContextMenu.Item onSelect={() => select(onCancelRun)}>
        <StopIcon />
        Stop run
      </ContextMenu.Item>
    {:else}
      <ContextMenu.Item disabled={!automation.enabled} onSelect={() => select(onRunNow)}>
        <PlayIcon />
        Run now
      </ContextMenu.Item>
    {/if}
    <ContextMenu.Item onSelect={() => select(onToggleEnabled)}>
      {#if automation.enabled}<PauseIcon /> Pause automation{:else}<PlayIcon /> Resume automation{/if}
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={() => select(onToggleFavorite)}>
      <StarIcon weight={automation.favorite ? "fill" : "regular"} />
      {automation.favorite ? "Unstar" : "Star"}
    </ContextMenu.Item>

    <ContextMenu.Separator />
    <ContextMenu.Item onSelect={() => void copyId()}>
      <CopyIcon />
      Copy automation ID
    </ContextMenu.Item>
    <ContextMenu.Item variant="destructive" onSelect={() => select(onDelete)}>
      <TrashIcon />
      Delete automation
    </ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>
