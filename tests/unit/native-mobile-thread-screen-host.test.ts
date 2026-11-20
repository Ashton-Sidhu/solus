import { expect, test } from 'bun:test'

// Run native module mocks in a child process so they cannot change other suites.
test('T3 screen host keeps the editor mounted across draft and live controllers', () => {
  const result = Bun.spawnSync({ cmd: [process.execPath, '-e', `
    import { mock } from 'bun:test';
    import { strict as assert } from 'node:assert';
    import { JSDOM } from 'jsdom';
    import React, { act, useEffect } from 'react';
    import { createRoot } from 'react-dom/client';
    import { resolve } from 'node:path';
    const dom = new JSDOM('<div id="root"></div>');
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    let mounts = 0;
    let unmounts = 0;
    mock.module('react-native', () => ({ View: ({ children }) => React.createElement('div', null, children) }));
    mock.module(resolve('apps/mobile/src/features/threads/ThreadDetailScreen.tsx'), () => ({
      ThreadDetailScreen: ({ draftMode }) => {
        useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
        return React.createElement('input', { 'data-mode': draftMode ? 'draft' : 'live' });
      },
    }));
    const { ThreadScreenHost, ThreadScreenBinding, ThreadScreenFallback } = await import(resolve('apps/mobile/src/features/threads/ThreadScreenHost.tsx'));
    const Draft = () => React.createElement(ThreadScreenBinding, { draftMode: {}, header: React.createElement('span', null, 'Draft') });
    const Live = () => React.createElement(ThreadScreenBinding, { header: React.createElement('span', null, 'Live') });
    const container = document.getElementById('root');
    const root = createRoot(container);
    await act(() => root.render(React.createElement(ThreadScreenHost, null, React.createElement(Draft))));
    const editor = container.querySelector('input');
    editor.value = 'retained native editor';
    await act(() => root.render(React.createElement(ThreadScreenHost, null, React.createElement(Live))));
    assert.equal(container.querySelector('input'), editor);
    assert.equal(editor.value, 'retained native editor');
    assert.equal(editor.dataset.mode, 'live');
    assert.equal(container.textContent, 'Live');
    assert.equal(mounts, 1);
    assert.equal(unmounts, 0);
    await act(() => root.render(React.createElement(ThreadScreenHost, null,
      React.createElement(ThreadScreenFallback, null, 'No access'))));
    assert.equal(container.querySelector('input'), null);
    assert.equal(container.textContent, 'No access');
    assert.equal(unmounts, 1);
    await act(() => root.unmount());
  `], cwd: process.cwd(), timeout: 20_000 })
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
})
