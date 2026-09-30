import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

// Reviewing a pull request with 932 threads and 343 reviews and comments froze
// the app: the Activity tab mounted every card, one diff engine per open thread
// and one markdown parse per body, in a single pass. This mounts the real
// timeline and thread card over a timeline of that shape and counts what they
// build. The diff and markdown renderers are stubs that count their mounts.

test('a timeline the size of a very large pull request mounts a bounded page and no diff off screen', async () => {
  const root = new URL('../../', import.meta.url)
  const directory = mkdtempSync(join(tmpdir(), 'solus-activity-timeline-'))
  const client = new URL('node_modules/svelte/src/index-client.js', root).href
  const internal = new URL('node_modules/svelte/src/internal/client/index.js', root).href
  const source = (path: string) => new URL(`packages/workspace-ui/src/${path}`, root)
  function component(text: string, name: string) {
    const code = compile(text, { filename: `${name}.svelte`, generate: 'client' }).js.code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(internal))
      .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
    const path = join(directory, `${name}.mjs`)
    writeFileSync(path, code)
    return JSON.stringify(path)
  }
  /** The component's own markup and state, with its imports replaced. */
  function withImports(path: string, imports: string) {
    return readFileSync(source(path), 'utf8')
      .replace(/^  import [\s\S]*?from\s+["'][^"']+["'];\n/gm, '')
      .replace('<script lang="ts">', `<script lang="ts">\n${imports}`)
  }
  try {
    const stub = component('<script>let { children } = $props();</script>{@render children?.()}', 'stub')
    const button = component('<script>let { children, ...props } = $props();</script><button {...props}>{@render children?.()}</button>', 'button')
    const trigger = component('<script>let { child } = $props();</script>{@render child?.({ props: {} })}', 'trigger')
    const markdown = component('<script>globalThis.markdownMounts++;</script><p></p>', 'markdown')
    const diff = component('<script>globalThis.diffMounts++;</script><div></div>', 'diff')
    const helpers = `
      import Stub from ${stub};
      import Button from ${button};
      import CommentMarkdown from ${markdown};
      import * as activityData from ${JSON.stringify(source('components/pr-review/lib/activity-data.ts').pathname)};
      const { activityEventKey, commitRunAuthorLabel, commitRunPreview, hasVisibleBody, prLabelActivityText,
        reviewThreadDiffHunks, threadStartsFolded, activityDiffPreview, diffLineCount, dirName, fileName,
        hunkToPatch } = activityData;
      const formatTimeAgoFromTimestamp = () => 'now', formatAbsoluteTimestamp = () => 'now';
      const requestInputFocus = () => {};
      const toasts = { error() {} };
      const PrAvatar = Stub;
    `
    const icons = (names: string[]) => `const ${names.map((name) => `${name} = Stub`).join(', ')};`
    const card = component(withImports('components/pr-review/PrThreadCard.svelte', `${helpers}
      import GuideFileDiff from ${diff};
      import { nearViewport } from ${JSON.stringify(source('lib/near-viewport.ts').pathname)};
      const CommentComposer = Stub;
      ${icons(['CheckCircleIcon', 'CircleIcon', 'CaretDownIcon', 'CaretRightIcon', 'CaretUpIcon'])}
    `), 'card')
    const timeline = component(withImports('components/pr-review/ActivityTimeline.svelte', `${helpers}
      import PrThreadCard from ${card};
      import Trigger from ${trigger};
      import { TIMELINE_WINDOW_PAGE, windowTimeline } from ${JSON.stringify(source('components/pr-review/lib/timeline-window.ts').pathname)};
      const TooltipUI = { Root: Stub, Trigger, Content: Stub };
      const Skeleton = Stub, ArtifactActivityCard = Stub, PrReviewStateBadge = Stub;
      ${icons(['CaretDownIcon', 'CircleAlertIcon', 'CheckCircleIcon', 'CircleDashedIcon', 'EllipsisIcon',
        'GitCommitIcon', 'GitPullRequestIcon', 'ArtifactIcon', 'LoaderIcon', 'TagIcon', 'TrashIcon'])}
    `), 'timeline')

    const runner = join(directory, 'test.mjs')
    writeFileSync(runner, `
      import assert from 'node:assert/strict';
      import { JSDOM } from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
      const dom = new JSDOM('<!doctype html><body></body>');
      for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Event', 'CustomEvent']) globalThis[key] = dom.window[key];
      globalThis.markdownMounts = 0;
      globalThis.diffMounts = 0;
      const observers = new Set();
      class FakeObserver {
        constructor(callback) { this.callback = callback; }
        observe() { observers.add(this); }
        disconnect() { observers.delete(this); }
      }
      globalThis.IntersectionObserver = FakeObserver;
      dom.window.IntersectionObserver = FakeObserver;
      const text = () => document.body.textContent.replace(/\\s+/g, ' ');
      const { mount, unmount, flushSync } = await import(${JSON.stringify(client)});
      const { default: Timeline } = await import(${timeline});

      // The shape of the pull request that froze: 932 threads, 696 of them
      // open and 589 of those outdated, and 343 reviews and comments.
      const hunk = '@@ -1,3 +1,3 @@\\n a\\n-b\\n+c\\n d';
      const events = [];
      for (let i = 0; i < 932; i++) {
        const isResolved = i >= 696;
        const isOutdated = isResolved ? i < 696 + 217 : i < 589;
        events.push({ kind: 'thread', ts: i * 2, thread: {
          id: 't' + i, filePath: 'src/f' + i + '.ts', line: 2, side: 'RIGHT', isResolved, isOutdated,
          comments: [{ id: 'tc' + i, author: 'reviewer', body: 'Please look', createdAt: '2026-09-01T00:00:00Z', diffHunk: hunk }],
        } });
      }
      for (let i = 0; i < 343; i++) {
        events.push({ kind: 'comment', ts: i * 2 + 1, comment: {
          kind: i < 282 ? 'review' : 'comment', id: 'c' + i, author: 'reviewer', body: 'A review body',
          createdAt: '2026-09-01T00:00:00Z', reviewState: 'COMMENTED',
        } });
      }
      events.sort((a, b) => a.ts - b.ts);
      const noop = async () => {};
      const app = mount(Timeline, { target: document.body, props: {
        events, authorName: 'author', openedAt: null, viewerLogin: 'me', deletingCommentIds: new Set(),
        onReply: noop, onResolve: noop, onDeleteComment: noop,
      } });
      flushSync();

      const started = { markdown: markdownMounts, diffs: diffMounts, observed: observers.size };
      // The first 10 and last 30 of 1275 events, and the row for the rest.
      assert.equal(document.querySelectorAll('ol > li').length, 1 + 40 + 1);
      assert.match(text(), /Show 50 of 1235 hidden events/);
      // No diff engine runs before its card nears the viewport.
      assert.equal(started.diffs, 0);
      assert.ok(started.markdown <= 40, 'mounted ' + started.markdown + ' markdown bodies');

      // Every open, current thread in the page builds its diff once reached.
      for (const observer of [...observers]) observer.callback([{ isIntersecting: true }]);
      flushSync();
      const openCurrentInPage = [...events.slice(0, 10), ...events.slice(-30)]
        .filter((event) => event.kind === 'thread' && !event.thread.isResolved && !event.thread.isOutdated).length;
      assert.equal(diffMounts, openCurrentInPage);
      assert.equal(started.observed, openCurrentInPage);

      // Revealing reads on from the start, one page at a time.
      [...document.querySelectorAll('button')].find((b) => /hidden\\s+events/.test(b.textContent)).click();
      flushSync();
      assert.equal(document.querySelectorAll('ol > li').length, 1 + 90 + 1);
      assert.match(text(), /Show 50 of 1185 hidden events/);

      await unmount(app);
      assert.equal(observers.size, 0);
      dom.window.close();
    `)
    const child = Bun.spawn([process.execPath, runner], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 60_000)
