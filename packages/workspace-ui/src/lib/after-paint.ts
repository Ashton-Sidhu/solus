/** Let the current UI commit and paint before starting secondary host work.
 * Hidden clients still refresh: browsers can suspend their animation frames.
 * A runtime with no animation frames paints nothing, so it does not wait. */
export function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (!('requestAnimationFrame' in globalThis)) return resolve()
    let frame: number | undefined
    const finish = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      clearTimeout(timeout)
      resolve()
    }
    const timeout = setTimeout(finish, 1_000)
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish) })
  })
}
