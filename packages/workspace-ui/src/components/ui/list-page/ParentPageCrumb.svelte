<script lang="ts">
  import { ChevronLeft as CaretLeftIcon } from "@lucide/svelte";
  import { navPageSpec, type NavPage } from "../../../lib/page-nav";
  import { SUB_PAGE_CRUMB_BTN } from "./sub-page-styles";

  /**
   * The leading segment of a sub page's crumb: the page it was opened from,
   * and the separator after it. A document, diagram, artifact, or plan is a
   * place inside the Workspace page the way a task is a place inside Tasks, so
   * its header has to name that page and take the reader back to it.
   *
   * The leaf after the separator stays the host's: each shell already renders
   * its own title, and the title doubles as the rename control there.
   */
  interface Props {
    page: NavPage;
    /** Leave this sub page and show the parent page. */
    onOpen: () => void;
  }
  let { page, onOpen }: Props = $props();

  const spec = $derived(navPageSpec(page));
</script>

<!-- On a record the page name in front of the record's own name is two names
     competing for one 393px line, and the reader only needs one of them: the
     way back. So the word becomes the platform's back chevron at the touch
     floor, and the separator after it has nothing left to separate. -->
<button
  type="button"
  class="{SUB_PAGE_CRUMB_BTN} text-workspace-chrome @max-[30rem]/pane:size-11! @max-[30rem]/pane:justify-center @max-[30rem]/pane:rounded-lg @max-[30rem]/pane:px-0 @max-[30rem]/pane:text-foreground"
  onclick={onOpen}
  title="Back to {spec.label}"
  aria-label="Back to {spec.label}"
  data-testid="parent-page-crumb"
>
  <span class="@max-[30rem]/pane:hidden">{spec.label}</span>
  <CaretLeftIcon size={19} class="hidden @max-[30rem]/pane:block" />
</button>
<span
  class="shrink-0 px-[3px] text-workspace-chrome text-muted-foreground opacity-30 [.is-laptop-display_&]:px-0.5 @max-[30rem]/pane:hidden"
  aria-hidden="true">/</span
>
