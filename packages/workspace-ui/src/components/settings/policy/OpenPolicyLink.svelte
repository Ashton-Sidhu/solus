<script lang="ts">
  /** "Open Policy": the way from a lock to the policy that sets it (Settings → Policy). */
  import { getWorkspaceContext } from "../../../contexts";

  const workspace = getWorkspaceContext();
</script>

<button
  type="button"
  class="shrink-0 rounded-sm font-medium text-(--solus-accent) underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-accent)/40"
  onclick={() => workspace.selectSettingsTab("policy")}
>
  Open Policy
</button>
