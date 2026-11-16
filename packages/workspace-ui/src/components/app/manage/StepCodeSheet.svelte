<script lang="ts">
  import { X as CloseIcon } from "@lucide/svelte";
  import type { AppStepSource } from "@solus/contracts/apps";
  import CodeEditor from "../../code-editor/CodeEditor.svelte";
  import { codeLanguageOfPath } from "../../code-editor/lib/code-languages";
  import { BottomSheet } from "../../ui/bottom-sheet";
  import { Button } from "../../ui/button";

  /**
   * The source of one workflow step, read-only, in a sheet over the page: the
   * file of the version that holds its `step.do` call, open at that line.
   * Escape closes it, and the cursor starts on the line.
   */
  interface Props {
    step: string;
    source: AppStepSource;
    onClose: () => void;
  }
  let { step, source, onClose }: Props = $props();
</script>

<BottomSheet label="The source of the step {step}" {onClose}>
  {#snippet header()}
    <div class="flex min-w-0 items-center gap-3">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <h3 class="m-0 truncate text-[15px] font-semibold text-foreground">{step}</h3>
        <span class="min-w-0 truncate font-mono text-xs text-(--solus-text-tertiary)" title={source.path}>{source.path}:{source.line} · version {source.version}</span>
      </div>
      <Button size="icon-sm" variant="ghost" class="shrink-0 rounded-full" aria-label="Close the source" onclick={onClose}><CloseIcon /></Button>
    </div>
  {/snippet}
  <CodeEditor
    value={source.text}
    readOnly
    autofocus
    language={codeLanguageOfPath(source.path)}
    ariaLabel="{source.path}, read-only"
    focusLine={source.line}
    testId="app-step-source"
  />
</BottomSheet>
