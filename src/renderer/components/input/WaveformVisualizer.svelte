<script lang="ts">
  interface Props {
    rmsRef: { current: number }
    color: string
    /** Drives the rAF loop. When false the loop stops (a parent that hides the
     *  canvas with display:none instead of unmounting does NOT pause
     *  requestAnimationFrame, so we must tear the loop down ourselves).
     *  Defaults true for callers that unmount the canvas to stop it. */
    active?: boolean
  }

  let { rmsRef, color, active = true }: Props = $props()

  let canvasEl: HTMLCanvasElement | null = $state(null)

  $effect(() => {
    const canvas = canvasEl
    if (!canvas || !active) return
    const dpr = window.devicePixelRatio || 1
    const setSize = () => {
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
    }
    setSize()
    const ctx = canvas.getContext('2d')!
    let frameId = 0
    let smoothRms = 0

    // Resolve the accent color once per activation. `getComputedStyle` forces a
    // style resolution; doing it per frame (60fps) against a possibly
    // display:none subtree is pure waste — the color doesn't change mid-loop.
    const resolvedColor = color.startsWith('var(')
      ? getComputedStyle(canvas).getPropertyValue(color.slice(4, -1).trim()).trim()
      : color

    // Three waves layered at different frequencies, speeds and opacities. Each
    // is tapered to zero at both ends (the sin() envelope) so the ribbon reads
    // as a single contained, living signal rather than a wall-to-wall wave.
    const layers = [
      { freq: 3, speed: 2.6, amp: 1.0, alpha: 0.9 },
      { freq: 5, speed: -3.8, amp: 0.66, alpha: 0.45 },
      { freq: 8, speed: 5.0, amp: 0.4, alpha: 0.25 },
    ]

    const draw = (now: number) => {
      const t = now / 1000
      const w = canvas.width / dpr
      const h = canvas.height / dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const target = rmsRef.current
      // Snap up fast on attack, ease down a touch slower so peaks stay legible.
      const speed = target > smoothRms ? 0.5 : 0.18
      smoothRms += (target - smoothRms) * speed
      // Lower divisor = reacts to quieter speech and gives a bigger swing
      // between soft and loud.
      const normalized = Math.min(smoothRms / 7, 1)
      // Low idle floor so voice volume has plenty of headroom to stand out;
      // a small breath keeps the ribbon alive between words.
      const breathe = 0.1 + 0.04 * Math.sin(t * 1.6)
      const energy = breathe + normalized
      const maxAmp = h / 2 - 1
      ctx.strokeStyle = resolvedColor
      ctx.lineWidth = 1.5
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (const layer of layers) {
        const amplitude = Math.min(energy * layer.amp, 1) * maxAmp
        ctx.globalAlpha = layer.alpha
        ctx.beginPath()
        for (let x = 0; x <= w; x++) {
          const p = x / w
          const envelope = Math.sin(p * Math.PI)
          const y = h / 2 + Math.sin(p * Math.PI * layer.freq + t * layer.speed) * amplitude * envelope
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      frameId = requestAnimationFrame(draw)
    }
    frameId = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frameId)
  })
</script>

<canvas bind:this={canvasEl} style="width:100%;height:1.25rem;display:block"></canvas>
