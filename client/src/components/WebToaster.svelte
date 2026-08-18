<script lang="ts">
  import { onMount } from "svelte";
  import { Toaster } from "@renderer/components/ui/sonner/index.js";
  import { runtime } from "@renderer/contexts";
  import { toasts } from "@renderer/lib/toasts";

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

<svelte:window onkeydowncapture={toasts.handleKeydown} />

<Toaster
  theme={isDark ? "dark" : "light"}
  position={runtime.isMobileViewport ? "top-center" : "top-right"}
  offset={{ top: "1rem", right: "1rem" }}
  visibleToasts={1}
  duration={6000}
  closeButton
  hotkey={TOAST_HOTKEY}
/>
