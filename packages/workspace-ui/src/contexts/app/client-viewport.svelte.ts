import { onDestroy } from 'svelte'

/** Geometry shared by the browser and native renderer; neither owns these DOM events. */
export class ClientViewport {
  workAreaWidth = $state(window.innerWidth)
  workAreaHeight = $state(window.innerHeight)

  constructor() {
    let frame = 0
    let resizeIdle = 0
    const root = document.documentElement
    const resize = () => {
      root.classList.add('solus-resizing')
      clearTimeout(resizeIdle)
      resizeIdle = window.setTimeout(() => root.classList.remove('solus-resizing'), 160)
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        this.workAreaWidth = window.innerWidth
        this.workAreaHeight = window.innerHeight
      })
    }
    window.addEventListener('resize', resize)
    onDestroy(() => {
      window.removeEventListener('resize', resize)
      if (frame) cancelAnimationFrame(frame)
      clearTimeout(resizeIdle)
      root.classList.remove('solus-resizing')
    })
  }
}
