import { describe, expect, test } from 'bun:test'
import { destructiveStatement } from '../../packages/workspace-ui/src/components/conversation/lib/interrupt'

// The red line on a permission card is a claim about one statement in the
// command. It must quote that statement, so the cause is visible even when it
// sits below the command box's fold, and it must not fire on commands that
// git can restore or that only look alike.
describe('destructiveStatement', () => {
  test.each([
    ['rm -rf build/', 'rm -rf build/', 'deletes a folder and everything in it'],
    ['cd out && rm -fr ./cache || true', 'rm -fr ./cache', 'deletes a folder and everything in it'],
    ['rm -f -R dist', 'rm -f -R dist', 'deletes a folder and everything in it'],
    ['sudo /bin/rm --recursive /var/x', 'rm --recursive /var/x', 'deletes a folder and everything in it'],
    ['git push origin main --force', 'git push origin main --force', 'rewrites history on the remote'],
    ['git push -f', 'git push -f', 'rewrites history on the remote'],
    ['dd if=image.iso of=/dev/disk4 bs=4m', 'dd if=image.iso of=/dev/disk4 bs=4m', 'writes raw bytes to a file or disk'],
    ['mkfs.ext4 /dev/sdb1', 'mkfs.ext4 /dev/sdb1', 'formats a disk'],
    ['sudo shutdown -h now', 'shutdown -h now', 'shuts down the machine'],
    ['killall node', 'killall node', 'stops every process with that name'],
  ])('%s', (command, statement, reason) => {
    expect(destructiveStatement(command)).toEqual({ statement, reason })
  })

  test('quotes the matching statement from the end of a long script', () => {
    const script = `cat > $S/scenes.mjs <<'EOF'\n${'const x = 1\n'.repeat(60)}EOF\ncd $S && rm -rf before; bun scenes.mjs before`
    expect(destructiveStatement(script)?.statement).toBe('rm -rf before')
  })

  test('shortens a long statement; the full command is in the box', () => {
    const statement = destructiveStatement(`rm -rf ${'a/'.repeat(100)}`)?.statement ?? ''
    expect(statement.length).toBe(80)
    expect(statement.endsWith('…')).toBe(true)
  })

  test.each([
    'rm -f before/*',
    'rm file.txt',
    'git rm -r --cached dist',
    'git push --force-with-lease',
    'git push origin main',
    'dd if=/dev/zero bs=1m count=1',
    'perform -r task',
    'node -e "server.shutdown()"',
    "cat > $S/scenes.mjs <<'EOF'\nconsole.log(1)\nEOF",
  ])('%s is an ordinary command', (command) => {
    expect(destructiveStatement(command)).toBeNull()
  })
})
