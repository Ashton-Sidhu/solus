import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

test('cloud source forms open with empty credentials, validate drafts, and keep a refused save visible', async () => {
  const root = new URL('../../', import.meta.url)
  const dir = mkdtempSync(join(tmpdir(), 'solus-cloud-device-ui-'))
  const client = new URL('node_modules/svelte/src/index-client.js', root).href
  function component(source: string, name: string) {
    const code = compile(source, { filename: `${name}.svelte`, generate: 'client' }).js.code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(new URL('node_modules/svelte/src/internal/client/index.js', root).href))
      .replaceAll(/(['"])svelte\1/g, JSON.stringify(client))
      .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
    const file = join(dir, `${name}.mjs`)
    writeFileSync(file, code)
    return file
  }
  try {
    const button = component('<script>let { children, ...props } = $props();</script><button {...props}>{@render children?.()}</button>', 'button')
    const input = component('<script>let { value = $bindable(), ...props } = $props();</script><input {...props} bind:value />', 'input')
    const section = component('<script>let { children, action } = $props();</script>{@render action?.()}{@render children()}', 'section')
    const store = join(dir, 'store.mjs')
    writeFileSync(store, `export const saved=[]; export const checked=[]; export let refuse=true; export function accept(){refuse=false;} export const devicesStore={async saveHost(host,config){saved.push({host,config});if(refuse)throw new Error('Source save refused.');},async testHost(host,config){checked.push({host,config});return {ok:true,isLocal:false,checks:[{name:config.kind,ok:true,detail:'Connection checked.'}]};}}; export const deviceErrorMessage=(error)=>error.message;`)
    const source = readFileSync(new URL('packages/workspace-ui/src/components/devices/CloudDeviceHosts.svelte', root), 'utf8')
      .replace(/^  import .*?;\n/gm, '')
      .replace('<script lang="ts">', `<script lang="ts">
        import { cloudDeviceHostConfigSchema, DEVICE_SECRET_SAVED } from ${JSON.stringify(new URL('packages/contracts/src/device-types.ts', root).href)};
        import { newCloudDeviceHost, cloudDeviceHostLimits } from ${JSON.stringify(new URL('packages/client-core/src/device-host-draft.ts', root).href)};
        import { devicesStore, deviceErrorMessage } from ${JSON.stringify(store)};
        import Button from ${JSON.stringify(button)};
        import Input from ${JSON.stringify(input)};
        import SettingsSection from ${JSON.stringify(section)};
      `)
    const cloud = component(source, 'cloud')
    const runner = join(dir, 'run.mjs')
    writeFileSync(runner, `
      import assert from 'node:assert/strict';
      import {writeSync} from 'node:fs';
      process.on('uncaughtException',error=>{writeSync(2,error.stack ?? String(error));process.exitCode=1;});
      process.on('unhandledRejection',error=>{writeSync(2,error instanceof Error ? error.stack ?? error.message : String(error));process.exitCode=1;});
      import {JSDOM} from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
      const dom=new JSDOM('<!doctype html><body></body>');
      for(const key of ['window','document','Node','Element','HTMLElement','HTMLInputElement','HTMLMediaElement','HTMLOptionElement','HTMLSelectElement','HTMLFormElement','HTMLButtonElement','MutationObserver','Text','Comment','Event','CustomEvent']) globalThis[key]=dom.window[key];
      const {mount,unmount,flushSync,tick}=await import(${JSON.stringify(client)});
      const {default:Cloud}=await import(${JSON.stringify(cloud)});
      const {saved,checked,accept}=await import(${JSON.stringify(store)});
      const app=mount(Cloud,{target:document.body,props:{serverId:'host-a',hosts:[],statuses:[]}});
      const button=(text)=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===text);
      const settle=async()=>{await tick();await Promise.resolve();flushSync();};
      flushSync();button('Add Simlock pool').click();await settle();
      assert.ok(document.querySelector('form'),'a blank gateway must render an editable form');
      assert.equal(document.querySelector('[aria-label="Gateway URL"]').value,'');
      assert.equal(button('Save source').disabled,true);
      const gateway=document.querySelector('[aria-label="Gateway URL"]');gateway.value='https://pool.test';gateway.dispatchEvent(new Event('input',{bubbles:true}));await settle();
      assert.equal(button('Save source').disabled,false);
      button('Check connection').click();await settle();
      assert.equal(checked[0].host,'host-a');assert.equal(checked[0].config.kind,'simlock');
      button('Save source').click();await settle();
      assert.ok(document.querySelector('form'));assert.match(document.querySelector('[role="alert"]').textContent,/Source save refused/);
      accept();button('Save source').click();await settle();
      assert.equal(document.querySelector('form'),null);assert.equal(saved.at(-1).config.maxLeaseMinutes,60);
      assert.equal(button('Add EAS Simulator'),undefined);
      await unmount(app);dom.window.close();
    `)
    const child = Bun.spawn([process.execPath, runner], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 60_000)
