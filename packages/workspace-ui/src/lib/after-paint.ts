/** Let the current UI commit and paint before starting secondary host work.
 * Hidden clients still refresh: browsers can suspend their animation frames. */
export function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    let frame: number | undefined
    const finish = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      clearTimeout(timeout)
      resolve()
    }
    const timeout = setTimeout(finish, 1_000)
    if ('requestAnimationFrame' in globalThis) {
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish) })
    }
  })
}
