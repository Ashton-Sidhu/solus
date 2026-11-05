import { describe, expect, test } from 'bun:test'
import { formatTokens as formatTokenCount } from '@solus/contracts/token-count'
import { formatFileSize } from '@solus/workspace-ui/components/files/lib/non-text-file'
import { formatVoiceModelBytes } from '@solus/workspace-ui/components/settings/lib/voice-model-bytes'
import { formatTokens } from '@solus/workspace-ui/components/insights/lib/format'
import { compactCount } from '@solus/workspace-ui/components/ui/list-page/list-page'
import { buildSize } from '@solus/workspace-ui/components/devices/lib/build-list'
import { fileSizeLabel } from '../../apps/mobile/src/features/files/lib/file-tree'

// A compact figure picks its unit after rounding. Picking it first shows a
// value that rounds up to the next unit as "1024 KB" or "1000k", a figure
// no unit system writes.
describe('compact figures step up a unit when rounding reaches it', () => {
  test('file sizes in the file pane', () => {
    expect(formatFileSize(1023)).toBe('1023 B')
    expect(formatFileSize(1024 * 1023)).toBe('1023 KB')
    expect(formatFileSize(1024 * 1024 - 1)).toBe('1.0 MB')
    expect(formatFileSize(1024 * 1024 * 1024 - 1)).toBe('1.0 GB')
    expect(formatFileSize(1024 * 9.96)).toBe('10 KB')
  })

  test('file sizes on mobile', () => {
    expect(fileSizeLabel(1024 * 1023)).toBe('1023.0 KB')
    expect(fileSizeLabel(1024 * 1024 - 1)).toBe('1.0 MB')
  })

  test('voice model and build sizes', () => {
    expect(formatVoiceModelBytes(1024 * 1023)).toBe('1023 KB')
    expect(formatVoiceModelBytes(1024 * 1024 - 1)).toBe('1 MB')
    expect(buildSize(1024 * 1024 - 1)).toBe('1.0 MB')
    expect(buildSize(1024 * 1023)).toBe('1023 KB')
  })

  test('token counts in Insights', () => {
    expect(formatTokens(999.4)).toBe('999')
    expect(formatTokens(999.6)).toBe('1.0k')
    expect(formatTokens(999_940)).toBe('999.9k')
    expect(formatTokens(999_960)).toBe('1.0M')
  })

  test('token counts elsewhere', () => {
    expect(formatTokenCount(999.6)).toBe('1K')
    expect(formatTokenCount(999_400)).toBe('999K')
    expect(formatTokenCount(999_600)).toBe('1M')
  })

  test('list counts', () => {
    expect(compactCount(999)).toBe('999')
    expect(compactCount(1200)).toBe('1.2k')
    expect(compactCount(999_940)).toBe('999.9k')
    expect(compactCount(999_960)).toBe('1M')
  })
})
