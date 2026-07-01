import { mount } from 'svelte'
import App from './App.svelte'
import './index.css'
import { warmDiffWorkerPool } from './lib/diff-worker-pool'

mount(App, { target: document.getElementById('root')! })

// Warm the diff highlighter pool on idle so the first diff open of the session
// doesn't pay the worker/WASM cold start. No-op if a diff opens first.
warmDiffWorkerPool()
