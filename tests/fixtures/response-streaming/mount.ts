import { mount, unmount } from 'svelte'
import ResponseStreaming from './ResponseStreaming.svelte'

export function mountResponseFixture() {
  const container = document.createElement('div')
  container.id = 'response-streaming-fixture'
  Object.assign(container.style, { position: 'fixed', inset: '0', zIndex: '99999', background: 'var(--solus-surface-base, #fff)', color: 'var(--foreground)', padding: '24px', overflow: 'auto' })
  document.body.append(container)
  const component = mount(ResponseStreaming, { target: container })
  return { update: component.update, destroy: () => { void unmount(component); container.remove() } }
}
