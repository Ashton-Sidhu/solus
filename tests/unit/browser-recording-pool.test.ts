import { expect, test } from 'bun:test'
import { playwrightEncoderPool } from '@solus/server/browser/recording-encoder-playwright'

test('disposing an encoder from a closed pool cannot close its replacement', async () => {
  const closed: number[] = []
  let launches = 0
  const pool = playwrightEncoderPool({
    launch: async () => {
      const browserNumber = ++launches
      return {
        newPage: async () => ({
          evaluate: async () => ({ ok: true, mimeType: 'video/mp4' }),
          close: async () => {},
        }),
        close: async () => { closed.push(browserNumber) },
      }
    },
  })
  const old = await pool.open({ width: 320, height: 240 })
  await pool.close()
  const replacement = await pool.open({ width: 320, height: 240 })
  await old.dispose()
  expect(closed).toEqual([1])
  await replacement.dispose()
  expect(closed).toEqual([1, 2])
})
