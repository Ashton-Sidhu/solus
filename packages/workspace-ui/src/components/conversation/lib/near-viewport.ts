/**
 * Call `onNear` once, the first time the node comes within a screen of the
 * viewport. A transcript full of expensive renders then costs one render per
 * block the reader actually reaches; a hidden tab (`display: none`) never
 * intersects, so it costs nothing until it is shown.
 */
export function nearViewport(node: HTMLElement, onNear: () => void) {
  if (!("IntersectionObserver" in window)) {
    onNear();
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onNear();
        observer.disconnect();
      }
    },
    { rootMargin: "320px" },
  );
  observer.observe(node);
  return { destroy: () => observer.disconnect() };
}
