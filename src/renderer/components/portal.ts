export function portal(node: HTMLElement, target: HTMLElement) {
  target.appendChild(node)
  return {
    update(newTarget: HTMLElement) {
      newTarget.appendChild(node)
    },
    destroy() {
      node.remove()
    },
  }
}
