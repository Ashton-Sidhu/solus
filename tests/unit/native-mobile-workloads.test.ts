import { describe, expect, test } from 'bun:test'
import { conversation, feedRows, streamReply } from '../fixtures/mobile-workloads'

// What the compiled `ThreadFeed` relies on from the data below it. The
// compiler can skip a row's render only when its inputs keep their identity;
// these checks hold that identity at the model, where a regression would
// make every token re-derive a long feed whatever the compiler does.
describe('native mobile workloads', () => {
  test('a streamed token changes one transcript row and leaves the feed order alone', () => {
    const model = conversation(1_000)
    const orderBefore = model.order
    const steps = streamReply(model, 200)
    // The prompt adds its row; the first chunk adds the reply's row.
    expect(steps.slice(0, 2).map((step) => step.orderChanged)).toEqual([true, true])
    const replyId = model.order.at(-1)
    const tokens = steps.slice(2)
    expect(tokens).toHaveLength(199)
    expect(tokens.every((step) => !step.orderChanged && step.changedItems.length === 1 && step.changedItems[0] === replyId)).toBe(true)
    expect(model.order).not.toBe(orderBefore)
    expect(model.order).toHaveLength(orderBefore.length + 2)
  })

  test('a conversation that is shown again reads the same order and rows it had', () => {
    // A tab return re-renders for navigation and focus, not for its data.
    const model = conversation(500)
    const order = model.order
    expect(model.takeChanges()).toEqual({ items: [], order: false, meta: false })
    expect(model.order).toBe(order)
    expect(feedRows(model)).toEqual(feedRows(model))
  })

  test('a long feed keeps one row per prompt, tool group, and reply', () => {
    const rows = feedRows(conversation(1_000))
    expect(rows.filter((row) => row.type === 'message')).toHaveLength(2_000)
    expect(rows.length).toBeGreaterThanOrEqual(2_000)
  })
})
