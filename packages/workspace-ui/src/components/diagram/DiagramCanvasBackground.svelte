<script lang="ts">
  import { Background, BackgroundVariant } from "@xyflow/svelte";
  import { getSettingsContext } from "../../contexts";

  // The canvas dot grid, in one place: the editing shell and the read-only
  // preview must read as the same surface, and the thumbnail already mirrors
  // these values in CSS.
  const theme = getSettingsContext();
</script>

<Background
  variant={BackgroundVariant.Dots}
  gap={22}
  size={1.4}
  patternColor={theme.isDark ? "rgba(255,255,255,0.08)" : "rgba(42,38,24,0.10)"}
/>
