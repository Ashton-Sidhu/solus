import { useState } from 'react'

export default function App() {
  const [allocation, setAllocation] = useState(50)
  const prompt = `Set the allocation to ${allocation} percent. Use the remaining ${100 - allocation} percent for the other category.`

  return (
    <main className="grid gap-5 p-4">
      <header className="grid gap-1">
        <h1 className="text-xl font-medium">Allocation explorer</h1>
        <p className="text-sm opacity-75">Example values. Changes stay in this page until reload.</p>
      </header>
      <section className="grid gap-4 rounded-lg border border-(--artifact-border) p-4" aria-label="Allocation controls">
        <label htmlFor="allocation" className="flex justify-between gap-3 text-sm">
          Allocation <output htmlFor="allocation">{allocation}%</output>
        </label>
        <input id="allocation" type="range" min="0" max="100" value={allocation} onChange={event => setAllocation(Number(event.target.value))} />
        <meter min="0" max="100" value={allocation} className="h-6 w-full" aria-label={`${allocation} percent allocated`} />
        <button type="button" onClick={() => setAllocation(50)} className="justify-self-start rounded-md border border-(--artifact-border) px-3 py-2 text-sm">Reset</button>
      </section>
      <label className="grid gap-2 text-sm">
        Copy these settings back into chat
        <textarea readOnly value={prompt} rows={3} className="w-full resize-y rounded-md border border-(--artifact-border) bg-transparent p-3" />
      </label>
    </main>
  )
}
