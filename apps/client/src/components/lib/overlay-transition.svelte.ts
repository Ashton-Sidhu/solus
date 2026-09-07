import { untrack } from 'svelte'

interface OverlayTransitionOptions {
  open: () => boolean
  panel: () => HTMLElement | undefined
  backdrop: () => HTMLElement | undefined
  hiddenTransform: string
  enterDuration: number
  backdropDuration: number
  onHidden?: () => void
}

export function useOverlayTransition(options: OverlayTransitionOptions) {
  let mounted = $state(false)
  let visible = $state(false)

  $effect(() => {
    if (options.open()) mounted = true
  })

  $effect(() => {
    const open = options.open()
    const panel = options.panel()
    const backdrop = options.backdrop()
    if (!panel || !backdrop) return
    return untrack(() => {
      let frame = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      let finished = false
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const resetStyles = () => {
        panel.style.transition = ''
        panel.style.transform = ''
        backdrop.style.transition = ''
        backdrop.style.opacity = ''
      }
      const finish = () => {
        if (finished) return
        finished = true
        if (timer) clearTimeout(timer)
        panel.removeEventListener('transitionend', onEnd)
        if (!open) {
          visible = false
          resetStyles()
          options.onHidden?.()
        }
      }
      const onEnd = (event: TransitionEvent) => {
        if (event.target === panel && event.propertyName === 'transform') finish()
      }
      if (open) {
        visible = true
        if (reducedMotion) resetStyles()
        else {
          panel.style.transition = 'none'
          panel.style.transform = options.hiddenTransform
          backdrop.style.transition = 'none'
          backdrop.style.opacity = '0'
          frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => {
              panel.style.transition = `transform ${options.enterDuration}ms cubic-bezier(0.32, 0.72, 0, 1)`
              backdrop.style.transition = `opacity ${options.backdropDuration}ms ease`
              panel.style.transform = ''
              backdrop.style.opacity = ''
            })
          })
        }
      } else if (visible) {
        if (reducedMotion) finish()
        else {
          panel.style.transition = 'transform 180ms ease-in'
          backdrop.style.transition = `opacity ${options.backdropDuration}ms ease`
          panel.style.transform = options.hiddenTransform
          backdrop.style.opacity = '0'
          panel.addEventListener('transitionend', onEnd)
          timer = setTimeout(finish, 200)
        }
      }
      return () => {
        finished = true
        cancelAnimationFrame(frame)
        if (timer) clearTimeout(timer)
        panel.removeEventListener('transitionend', onEnd)
      }
    })
  })

  return {
    get mounted() { return mounted },
    get visible() { return visible },
  }
}
