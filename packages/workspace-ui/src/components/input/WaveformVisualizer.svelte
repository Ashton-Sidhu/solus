<script lang="ts">
  const BAR_WIDTH = 2
  const BAR_STEP = 5
  const SAMPLE_MS = 70
  const FADE_WIDTH = 32

  interface Props {
    rmsRef: { current: number }
    color: string
  }

  let { rmsRef, color }: Props = $props()

  let canvasEl: HTMLCanvasElement | null = $state(null)

  $effect(() => {
    const canvas = canvasEl
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const setSize = () => {
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
    }
    setSize()
    const resizeObserver = new ResizeObserver(setSize)
    resizeObserver.observe(canvas)
    const ctx = canvas.getContext('2d')!
    let frameId = 0
    let smoothRms = 0
    let lastSampleAt = 0
    const levels: number[] = []
    const scrolls = !window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // Resolve the color once per mount. `getComputedStyle` forces a style
    // resolution, and the color doesn't change mid-loop.
    const resolvedColor = color.startsWith('var(')
      ? getComputedStyle(canvas).getPropertyValue(color.slice(4, -1).trim()).trim()
      : color

    // Real levels scroll in from the right, one bar per sample. Silence stays a
    // row of dots, so the meter never moves unless the mic hears something.
    const draw = (now: number) => {
      const w = canvas.width / dpr
      const h = canvas.height / dpr
      const target = rmsRef.current
      // Snap up fast on attack, ease down a touch slower so peaks stay legible.
      smoothRms += (target - smoothRms) * (target > smoothRms ? 0.5 : 0.18)
      if (now - lastSampleAt >= SAMPLE_MS) {
        lastSampleAt = now
        levels.push(Math.min(smoothRms / 7, 1))
        if (levels.length > w / BAR_STEP + 2) levels.shift()
      }
      const scroll = scrolls ? Math.min((now - lastSampleAt) / SAMPLE_MS, 1) * BAR_STEP : 0
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = resolvedColor
      levels.forEach((level, index) => {
        const x = w - BAR_WIDTH - (levels.length - 1 - index) * BAR_STEP - scroll
        const height = Math.max(BAR_WIDTH, level * h)
        ctx.globalAlpha = Math.max(0, Math.min(x / FADE_WIDTH, 1))
        ctx.beginPath()
        ctx.roundRect(x, (h - height) / 2, BAR_WIDTH, height, 1)
        ctx.fill()
      })
      ctx.globalAlpha = 1
      frameId = requestAnimationFrame(draw)
    }
    frameId = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frameId)
      resizeObserver.disconnect()
    }
  })
</script>

<canvas bind:this={canvasEl} style="width:100%;height:1.25rem;display:block"></canvas>
