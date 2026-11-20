import { expect, test } from 'bun:test'
import { composerSubmissionBehavior } from '../../apps/mobile/src/features/threads/thread-feed-scroll-position'

const ready = { isIOS: true, keyboardVisible: false, hasUserMessage: false, contentReady: true, anchorsSubmission: false }

test('an anchored first prompt follows after the keyboard leaves', () => {
  expect(composerSubmissionBehavior({ ...ready, anchorsSubmission: true })).toEqual({ blurEditor: true, dismissKeyboard: true, followSubmission: true })
})
test('an iOS follow-up with a keyboard keeps first responder until keyboard dismissal', () => {
  expect(composerSubmissionBehavior({ ...ready, hasUserMessage: true, keyboardVisible: true })).toEqual({ blurEditor: false, dismissKeyboard: true, followSubmission: true })
})
test('a queued follow-up without a keyboard leaves the reading position alone', () => {
  expect(composerSubmissionBehavior({ ...ready, hasUserMessage: true })).toEqual({ blurEditor: true, dismissKeyboard: false, followSubmission: false })
})
test('an unavailable feed dismisses the iOS keyboard without scrolling', () => {
  expect(composerSubmissionBehavior({ ...ready, contentReady: false, hasUserMessage: true, keyboardVisible: true })).toEqual({ blurEditor: false, dismissKeyboard: true, followSubmission: false })
})
test('Android does not use the iOS first-responder handoff', () => {
  expect(composerSubmissionBehavior({ ...ready, isIOS: false, hasUserMessage: true, keyboardVisible: true })).toEqual({ blurEditor: true, dismissKeyboard: false, followSubmission: false })
})
