<script lang="ts">
  import EditorInputCard from "@solus/workspace-ui/components/input/EditorInputCard.svelte";
  import WorkspaceBody from "@solus/workspace-ui/components/layout/WorkspaceBody.svelte";
  import ConnectionStatusOverlay from "@solus/workspace-ui/components/servers/ConnectionStatusOverlay.svelte";

  interface Props {
    onAttachFile: (tabId?: string) => void | Promise<void>;
    /** Why the composer takes nothing right now, when the page knows better than the session does. */
    readOnlyReason?: string | null;
  }
  let { onAttachFile, readOnlyReason = null }: Props = $props();
</script>

<ConnectionStatusOverlay />

<div class="web-frame">
  <div class="workspace" data-solus-ui>
    <WorkspaceBody
      active
      enableProjectPanel
      {onAttachFile}
    >
    {#snippet inputRow()}
      <EditorInputCard
        active
        class="mx-auto max-w-(--solus-reading-max)"
        onAttachFile={() => onAttachFile()}
        {readOnlyReason}
      />
    {/snippet}
    </WorkspaceBody>
  </div>
</div>

<style>
  /* Web fills the viewport edge-to-edge so the app reads as a native web
     surface rather than a floating desktop-style card. */
  .web-frame {
    height: 100%;
    width: 100%;
    background: var(--solus-container-bg);
  }

  .workspace {
    display: flex;
    height: 100%;
    width: 100%;
    overflow: hidden;
    background: var(--solus-container-bg);
    contain: layout paint;
  }

  .workspace :global(.conversation-selectable) {
    padding-inline: 1.25rem;
  }

  .workspace :global(.sidebar-header-desktop) {
    padding-bottom: 0.625rem;
  }

</style>
