<script lang="ts">
  import SidePanel from "@solus/workspace-ui/components/layout/SidePanel.svelte";
  import SessionSidebarSkeleton from "@solus/workspace-ui/components/session/SessionSidebarSkeleton.svelte";
  import DeferredPromptEditor from "@solus/workspace-ui/components/ui/DeferredPromptEditor.svelte";
  import * as Tooltip from "@solus/workspace-ui/components/ui/tooltip";
  import { setClientShellContext } from "@solus/workspace-ui/contexts/app/client-shell.svelte";
  import {
    SIDEBAR_MAX_WIDTH,
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_PANE_DEFAULT_SIZE,
  } from "@solus/workspace-ui/components/layout/lib/workspace-body";

  /**
   * The empty workspace as the build writes it into the web page's HTML
   * (docs/plans/fast-secure-startup.md, step 5): the session sidebar while it
   * loads and an empty draft, in the places `WorkspaceBody` and `SessionDraftPane`
   * put them. The browser paints it when the HTML arrives; the workspace
   * replaces it when its code has run (`first-screen.ts`). Nothing in it belongs
   * to a person: sessions, hosts, projects, and saved pane widths arrive with
   * the workspace. The theme comes from the page's inline script.
   */

  // The web shell's answers that this frame reads: a browser page has no inset titlebar.
  setClientShellContext({
    visible: true,
    workAreaWidth: 0,
    workAreaHeight: 0,
    hasInsetTitlebar: false,
    supportsLocalAttachments: false,
    supportsNativeSettings: false,
    hasProjectPanel: true,
    hasCompanionPanes: true,
    canOpenResource: () => false,
    openResource: () => {},
    attachWorkspace: () => {},
  });
</script>

<Tooltip.Provider>
  <div
    data-first-screen
    class="flex h-full w-full overflow-hidden bg-(--solus-container-bg)"
  >
    <div
      class="h-full min-w-0 overflow-hidden bg-(--solus-container-bg)"
      style:flex="{SIDEBAR_PANE_DEFAULT_SIZE} 1 0px"
    >
      <SidePanel
        managedWidth
        isElevated={false}
        minWidth={SIDEBAR_MIN_WIDTH}
        maxWidth={SIDEBAR_MAX_WIDTH}
        onAction={() => {}}
        actionAriaLabel="Collapse sidebar"
        background="color-mix(in oklch, var(--card) 99%, var(--foreground))"
      >
        <SessionSidebarSkeleton />
      </SidePanel>
    </div>
    <main
      class="flex h-full min-w-0 flex-col bg-(--solus-container-bg)"
      style:flex="{100 - SIDEBAR_PANE_DEFAULT_SIZE} 1 0px"
    >
      <div class="relative flex h-full min-h-0 w-full flex-col items-center justify-center gap-5 px-6 py-3">
        <div class="relative w-full max-w-[max(min(60%,50rem),min(100%,30rem))]">
          <div class="absolute inset-x-0 bottom-full pb-4">
            <h1 class="w-full text-center text-3xl leading-[1.25] font-normal tracking-tight text-pretty text-(--solus-text-primary)">
              What should we build?
            </h1>
          </div>
          <div
            class="@container/composer overflow-hidden rounded-3xl bg-(--solus-input-pill-bg) px-3 pb-3 shadow-[shadow:0_0_0_0.03125rem_var(--solus-container-border),0_12px_28px_-18px_rgb(0_0_0/40%)] dark:shadow-[shadow:0_0_0_0.03125rem_var(--solus-container-border)]"
          >
            <div
              class="[--plain-editor-font-size:var(--solus-prompt-font-size)] [font-family:var(--solus-prompt-font-family)] [--plain-editor-line-height:1.625]"
            >
              <!-- Only the stand-in draws here, and it reads only the text props;
                   the editor's own props are empty. -->
              <DeferredPromptEditor
                pluginCommands={{ global: [], project: [] }}
                provider="claude-code"
                workingDirectory={undefined}
                value=""
                onValueChange={() => {}}
                placeholder="Plan, Build, Automate · @ files, / commands, # references"
                maxHeight={260}
              />
            </div>
            <!-- The toolbar's row: the workspace draws its controls here. -->
            <div class="h-[1.875rem]"></div>
          </div>
        </div>
      </div>
    </main>
  </div>
</Tooltip.Provider>
