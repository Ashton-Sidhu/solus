import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

/**
 * A device setting switch shows what the host stored. When the host refuses a
 * change, the switch must not keep the value the person asked for: that is
 * how "Agent access" looked on while the stored settings still said off.
 */
test('a refused device setting leaves its switch at the stored value and says why', async () => {
  const root = new URL('../../', import.meta.url)
  const directory = mkdtempSync(join(tmpdir(), 'solus-device-settings-'))
  const client = new URL('node_modules/svelte/src/index-client.js', root).href
  const reactivity = new URL('node_modules/svelte/src/reactivity/index-client.js', root).href
  function component(source: string, name: string) {
    const code = compile(source, { filename: `${name}.svelte`, generate: 'client' }).js.code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(new URL('node_modules/svelte/src/internal/client/index.js', root).href))
      .replaceAll(/(['"])svelte\/reactivity\1/g, JSON.stringify(reactivity))
      .replaceAll(/(['"])svelte\1/g, JSON.stringify(client))
      .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
    const path = join(directory, `${name}.mjs`)
    writeFileSync(path, code)
    return path
  }
  try {
    const button = component('<script>let { children, ...props } = $props();</script><button {...props}>{@render children?.()}</button>', 'button')
    // The shadcn Switch over bits-ui: a click writes `checked`, then reports it.
    const switchControl = component(`<script>
      let { checked = $bindable(false), onCheckedChange, disabled = false, ...rest } = $props();
    </script>
    <button role="switch" aria-checked={checked} {disabled} {...rest}
      onclick={() => { checked = !checked; onCheckedChange?.(checked); }}></button>`, 'switch')
    const section = component('<script>let { children, action } = $props();</script>{@render action?.()}{@render children()}', 'section')
    const row = component('<script>let { control, body, bodyVisible = true } = $props();</script>{@render control?.()}{#if body && bodyVisible}{@render body()}{/if}', 'row')
    const store = join(directory, 'store.mjs')
    writeFileSync(store, `
      import { SvelteMap } from ${JSON.stringify(reactivity)};
      export const states = new SvelteMap();
      export const requests = [];
      export let refuse = true;
      export function accept() { refuse = false; }
      export const devicesStore = {
        unavailable: new SvelteMap(),
        state: (serverId) => states.get(serverId),
        load: async () => {},
        async configure(serverId, request) {
          requests.push(request);
          if (refuse) throw new Error('Only an administrator of this host can change device settings.');
          const current = states.get(serverId);
          states.set(serverId, { ...current, revision: current.revision + 1, settings: { ...current.settings, ...request } });
        },
      };
    `)
    const source = readFileSync(new URL('packages/workspace-ui/src/components/devices/DeviceSettings.svelte', root), 'utf8')
      .replace(/^  import .*?;\n/gm, '')
      .replace('<script lang="ts">', `<script lang="ts">
        import { untrack } from 'svelte';
        import { devicesStore } from ${JSON.stringify(store)};
        import SettingsSection from ${JSON.stringify(section)};
        import SettingsRow from ${JSON.stringify(row)};
        import Button from ${JSON.stringify(button)};
        import Switch from ${JSON.stringify(switchControl)};
        const deviceErrorMessage = (cause) => cause.message;
        const AGENT_DEVICE_VERSION = '0.0.0', DEVICE_HUB_VERSION = '0.0.0';
        const sshDeviceHostConfigSchema = { safeParse: () => ({ success: false, error: { issues: [] } }) };
        const emptySshHostDraft = () => ({ id: '', label: '', target: '', port: '', identityFile: '' });
        const sshHostDraftConfig = (draft) => draft;
      `)
    const settings = component(source, 'device-settings')
    const runner = join(directory, 'test.mjs')
    writeFileSync(runner, `
      import assert from 'node:assert/strict';
      import { JSDOM } from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
      const dom = new JSDOM('<!doctype html><body></body>');
      for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Event', 'CustomEvent']) globalThis[key] = dom.window[key];
      const { mount, unmount, flushSync, tick } = await import(${JSON.stringify(client)});
      const { states, requests, accept } = await import(${JSON.stringify(store)});
      const { default: DeviceSettings } = await import(${JSON.stringify(settings)});
      states.set('host-a', {
        revision: 1,
        settings: { enabled: true, agentAccessEnabled: false, onboardingCompleted: true, autoShowAgentDevices: true },
        hosts: [], hostStatuses: [], devices: [], previews: [], booting: [], controls: [],
      });
      const app = mount(DeviceSettings, { target: document.body, props: { serverId: 'host-a' } });
      flushSync();
      const agentAccess = () => document.querySelector('[aria-label="Agent access"]');
      assert.equal(agentAccess().getAttribute('aria-checked'), 'false');

      agentAccess().click();
      await tick(); await tick();
      flushSync();
      assert.deepEqual(requests, [{ agentAccessEnabled: true }]);
      assert.equal(agentAccess().getAttribute('aria-checked'), 'false', 'a refused change must not show as on');
      assert.equal(agentAccess().disabled, false);
      assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Only an administrator/);

      accept();
      agentAccess().click();
      await tick(); await tick();
      flushSync();
      assert.deepEqual(requests.at(-1), { agentAccessEnabled: true });
      assert.equal(agentAccess().getAttribute('aria-checked'), 'true');
      assert.equal(document.querySelector('[role="alert"]'), null);
      await unmount(app);
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
