<script lang="ts">
  import {
    AppWindow as ArtifactIcon,
    FileText as FileTextIcon,
    Folder as FolderIcon,
    MessageCirclePlus as NewSessionIcon,
    Presentation as PresentationIcon,
    RefreshCw as AutomationIcon,
  } from "@lucide/svelte";
  import type { PickerRecord } from "./lib/picker-records";

  /** The mark of a record's kind: the icon its own page gives it, so a row in
   *  the search reads as the same thing it is in the Workspace, the pull
   *  requests page or the places column. A pull request has no mark here: its
   *  row is the row of the pull requests page (`PickerPullRequestRow`). */
  interface Props {
    record: Exclude<PickerRecord, { type: "pullRequest" }>;
    size: number;
  }
  let { record, size }: Props = $props();
</script>

{#if record.type === "work"}
  {#if record.item.glyph === "artifact" || record.item.glyph === "app"}
    <ArtifactIcon {size} />
  {:else if record.item.glyph === "slides"}
    <PresentationIcon {size} />
  {:else}
    <FileTextIcon {size} />
  {/if}
{:else if record.type === "automation"}
  <AutomationIcon {size} />
{:else if record.type === "project"}
  <FolderIcon {size} />
{:else}
  <NewSessionIcon {size} />
{/if}
