<script lang="ts">
  import { onMount } from "svelte";
  import { Toaster } from "@solus/workspace-ui/components/ui/sonner/index.js";
  import { runtime } from "@solus/workspace-ui/contexts";

  const TOAST_HOTKEY = ["altKey", "shiftKey", "KeyT"];
  let isDark = $state(document.documentElement.classList.contains("dark"));

  onMount(() => {
    const observer = new MutationObserver(() => {
      isDark = document.documentElement.classList.contains("dark");
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  });
</script>

<Toaster
  theme={isDark ? "dark" : "light"}
  position={runtime.isMobileViewport ? "top-center" : "top-right"}
  offset={{ top: "1rem", right: "1rem" }}
  visibleToasts={3}
  duration={6000}
  closeButton
  hotkey={TOAST_HOTKEY}
/>
