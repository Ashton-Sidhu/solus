let activeTooltip: HTMLElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;

function removeActive() {
  if (activeTooltip) {
    activeTooltip.remove();
    activeTooltip = null;
  }
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
}

export function tooltip(node: HTMLElement, text: string | null) {
  function show() {
    if (!text) return;
    removeActive();
    showTimer = setTimeout(() => {
      const el = document.createElement("div");
      el.className = "solus-tooltip";
      el.textContent = text;
      document.body.appendChild(el);
      activeTooltip = el;

      const rect = node.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      let left = rect.left + rect.width / 2 - elRect.width / 2;
      left = Math.max(6, Math.min(left, window.innerWidth - elRect.width - 6));

      const spaceAbove = rect.top;
      let top: number;
      if (spaceAbove >= elRect.height + 6) {
        top = rect.top - elRect.height - 6;
        el.classList.add("solus-tooltip--above");
      } else {
        top = rect.bottom + 6;
        el.classList.add("solus-tooltip--below");
      }

      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    }, 600);
  }

  function hide() {
    removeActive();
  }

  node.addEventListener("mouseenter", show);
  node.addEventListener("mouseleave", hide);
  node.addEventListener("click", hide);

  return {
    update(newText: string | null) {
      text = newText;
      if (!text) removeActive();
    },
    destroy() {
      node.removeEventListener("mouseenter", show);
      node.removeEventListener("mouseleave", hide);
      node.removeEventListener("click", hide);
      removeActive();
    },
  };
}
