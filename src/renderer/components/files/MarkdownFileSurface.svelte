<script lang="ts">
  import { untrack } from "svelte";
  import type { IpcContext } from "../../../shared/types";
  import type { HostApi } from "@client-core/host-api";
  import FilePreviewStream, {
    type FileSaveState,
  } from "../artifact/FilePreviewStream.svelte";
  import MarkdownFilePreview from "./MarkdownFilePreview.svelte";
  import type { MarkdownFileViewMode } from "./lib/markdown-file";

  interface Props {
    api: HostApi;
    ctx: IpcContext;
    cwd: string;
    filePath: string;
    displayPath: string;
    contents: string;
    isDark: boolean;
    mode: MarkdownFileViewMode;
    isReadOnly?: boolean;
    line?: number;
    revealEpoch?: number;
    onSaveStateChange?: (state: FileSaveState) => void;
  }

  let {
    api,
    ctx,
    cwd,
    filePath,
    displayPath,
    contents,
    isDark,
    mode,
    isReadOnly = false,
    line,
    revealEpoch = 0,
    onSaveStateChange,
  }: Props = $props();

  let renderedContents = $state(untrack(() => contents));
  let hasMountedRendered = $state(untrack(() => mode === "rendered"));
  let hasMountedSource = $state(untrack(() => mode === "source"));

  $effect(() => {
    renderedContents = contents;
  });

  $effect(() => {
    if (mode === "rendered") hasMountedRendered = true;
    else hasMountedSource = true;
  });
</script>

<div class="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
  {#if hasMountedRendered}
    <div
      class="h-full min-h-0 min-w-0 flex-1"
      style:display={mode === "rendered" ? undefined : "none"}
      aria-hidden={mode !== "rendered"}
    >
      <MarkdownFilePreview
        {ctx}
        {cwd}
        {filePath}
        {displayPath}
        contents={renderedContents}
      />
    </div>
  {/if}

  {#if hasMountedSource}
    <div
      class="h-full min-h-0 min-w-0 flex-1"
      style:display={mode === "source" ? undefined : "none"}
      aria-hidden={mode !== "source"}
    >
      <FilePreviewStream
        {api}
        {ctx}
        {cwd}
        {filePath}
        {displayPath}
        {contents}
        {line}
        {revealEpoch}
        {isDark}
        {isReadOnly}
        {onSaveStateChange}
        onContentsChange={(nextContents) => {
          renderedContents = nextContents;
        }}
      />
    </div>
  {/if}
</div>
