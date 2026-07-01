<script lang="ts">
  import type { DiagramNode, DiagramField } from '../../../shared/diagram-types'
  import IconPicker from './IconPicker.svelte'
  import DiagramDrawerShell from './DiagramDrawerShell.svelte'
  import Dropdown from '../ui/Dropdown.svelte'
  import DropdownItem from '../ui/DropdownItem.svelte'
  import {
    STATUS_COLORS,
    DIAGRAM_GREEN,
    DIAGRAM_AMBER,
    DIAGRAM_RED,
    DIAGRAM_BLUE,
    DIAGRAM_PURPLE,
    DIAGRAM_GRAY,
  } from './diagram-colors'
  import {
    DIAGRAM_NODE_SHAPE_OPTIONS,
    isDecorativeNodeShape,
    isSimpleShapeNode,
  } from './diagram-node-shapes'

  interface Props {
    node: DiagramNode
    onClose: () => void
    onUpdateNode: (id: string, patch: Partial<DiagramNode>) => void
    // When opened via an explicit edit intent (add node, "Edit details") we
    // focus the label input. On plain selection we don't, so canvas keyboard
    // shortcuts keep working.
    autoFocus?: boolean
    // Drill-down: whether this node may own a detail sub-diagram (top-level,
    // non-group), whether it already has one, and the handler to open it.
    canDetail?: boolean
    hasDetail?: boolean
    onOpenDetail?: () => void
    onRemoveDetail?: () => void
  }

  let {
    node,
    onClose,
    onUpdateNode,
    autoFocus = false,
    canDetail = false,
    hasDetail = false,
    onOpenDetail,
    onRemoveDetail,
  }: Props = $props()

  // Groups are pure containers — they carry only a label + icon, so the drawer
  // hides the node-only fields (status/badges/tags/metrics/body/subtitle).
  const isGroup = $derived(!!node.group)

  const STATUSES: NonNullable<DiagramNode['status']>[] = ['healthy', 'warn', 'error', 'info', 'muted']

  // Accent palette for the node/group card — mirrors the edge drawer's swatches
  // (and the node status hues) so colour reads consistently across the editor.
  // `undefined` = the default theme accent.
  const COLORS: { value: string | undefined; label: string; swatch: string }[] = [
    { value: undefined, label: 'Default', swatch: 'var(--solus-accent)' },
    { value: DIAGRAM_GREEN, label: 'Green', swatch: DIAGRAM_GREEN },
    { value: DIAGRAM_AMBER, label: 'Amber', swatch: DIAGRAM_AMBER },
    { value: DIAGRAM_RED, label: 'Red', swatch: DIAGRAM_RED },
    { value: DIAGRAM_BLUE, label: 'Blue', swatch: DIAGRAM_BLUE },
    { value: DIAGRAM_PURPLE, label: 'Purple', swatch: DIAGRAM_PURPLE },
    { value: DIAGRAM_GRAY, label: 'Gray', swatch: DIAGRAM_GRAY },
  ]

  // Card outline picker. 'rectangle' is the implicit default, so selecting it
  // clears the field rather than persisting the default value.
  const canUseDecorativeShape = $derived(isSimpleShapeNode(node))
  const shapeOptions = $derived(
    DIAGRAM_NODE_SHAPE_OPTIONS.filter((shape) => canUseDecorativeShape || !shape.decorative),
  )
  const activeShape = $derived(
    isDecorativeNodeShape(node.shape) && !canUseDecorativeShape ? 'rectangle' : (node.shape ?? 'rectangle'),
  )

  // Click-action editor. Only the genuinely user-authorable actions the canvas
  // handles are surfaced: open a URL, or focus the node's neighbours. 'none'
  // clears the action.
  type ClickKind = 'none' | 'openUrl' | 'focus'

  // Local editable mirror. Resynced only when the drawer switches to a
  // different node (see $effect below) — within a node the form owns the values
  // so typing never fights the live patch round-trip.
  let label = $state('')
  let subtitle = $state('')
  let status = $state<DiagramNode['status'] | ''>('')
  let badges = $state<string[]>([])
  let tags = $state<string[]>([])
  let metrics = $state<{ k: string; v: string }[]>([])
  let fields = $state<DiagramField[]>([])
  let body = $state('')

  // Key cycles none → pk → fk → unique on click; the glyph mirrors the node's
  // field table so the editor and canvas read identically.
  const FIELD_KEY_CYCLE: (DiagramField['key'] | undefined)[] = [undefined, 'pk', 'fk', 'unique']
  const FIELD_KEY_GLYPH = { pk: 'PK', fk: 'FK', unique: 'UQ' } as const

  let badgeDraft = $state('')
  let tagDraft = $state('')
  let clickKind = $state<ClickKind>('none')
  let clickValue = $state('')

  // Status / on-click selects (shared Dropdown — trigger width drives the menu
  // width so the popover matches the full-width field).
  let statusMenuOpen = $state(false)
  let statusTriggerEl = $state<HTMLButtonElement | null>(null)
  let statusTriggerW = $state(0)
  let clickMenuOpen = $state(false)
  let clickTriggerEl = $state<HTMLButtonElement | null>(null)
  let clickTriggerW = $state(0)

  const CLICK_OPTIONS: { value: ClickKind; label: string }[] = [
    { value: 'none', label: 'Nothing' },
    { value: 'openUrl', label: 'Open a URL…' },
    { value: 'focus', label: 'Focus connections' },
  ]
  const clickLabel = $derived(
    CLICK_OPTIONS.find((o) => o.value === clickKind)?.label ?? 'Nothing',
  )

  let syncedId = $state<string | null>(null)
  $effect(() => {
    // Only the node.id read is tracked when the guard is false, so this resyncs
    // exactly once per node switch — not on every live patch.
    if (node.id !== syncedId) {
      syncedId = node.id
      label = node.label
      subtitle = node.subtitle ?? ''
      status = node.status ?? ''
      badges = [...(node.badges ?? [])]
      tags = [...(node.tags ?? [])]
      metrics = Object.entries(node.metrics ?? {}).map(([k, v]) => ({ k, v }))
      fields = (node.fields ?? []).map((f) => ({ ...f }))
      body = node.body ?? ''
      badgeDraft = ''
      tagDraft = ''
      const click = node.actions?.find((a) => a.on === 'click')?.action
      if (click?.do === 'openUrl') { clickKind = 'openUrl'; clickValue = click.url }
      else if (click?.do === 'focus') { clickKind = 'focus'; clickValue = '' }
      else { clickKind = 'none'; clickValue = '' }
    }
  })

  function commit(patch: Partial<DiagramNode>) {
    onUpdateNode(node.id, patch)
  }

  const statusColor = $derived(status ? (STATUS_COLORS[status] ?? null) : null)

  // A colour outside the preset palette came from the custom picker, so the
  // custom swatch owns the active ring and seeds the native input.
  const isCustomColor = $derived(
    node.color != null && !COLORS.some((c) => c.value === node.color),
  )

  // Reflect the persisted action into the editor, then write it back. openUrl
  // needs a value — an empty one clears the action rather than persist a no-op.
  function commitAction() {
    if (clickKind === 'none') { commit({ actions: undefined }); return }
    if (clickKind === 'focus') { commit({ actions: [{ on: 'click', action: { do: 'focus' } }] }); return }
    const v = clickValue.trim()
    if (!v) { commit({ actions: undefined }); return }
    commit({
      actions: [{ on: 'click', action: { do: 'openUrl', url: v } }],
    })
  }
  function onClickKindChange() {
    clickValue = ''
    commitAction()
  }

  function onLabelInput() {
    const trimmed = label.trim()
    if (trimmed) commit({ label: trimmed })
  }
  function onSubtitleInput() {
    commit({ subtitle: subtitle.trim() || undefined })
  }
  function onStatusChange() {
    commit({ status: status || undefined })
  }
  function onBodyInput() {
    commit({ body: body.trim() || undefined })
  }

  function addBadge() {
    const v = badgeDraft.trim()
    if (!v) return
    badges = [...badges, v]
    badgeDraft = ''
    commit({ badges })
  }
  function removeBadge(i: number) {
    badges = badges.filter((_, idx) => idx !== i)
    commit({ badges: badges.length ? badges : undefined })
  }

  function addTag() {
    const v = tagDraft.trim()
    if (!v) return
    tags = [...tags, v]
    tagDraft = ''
    commit({ tags })
  }
  function removeTag(i: number) {
    tags = tags.filter((_, idx) => idx !== i)
    commit({ tags: tags.length ? tags : undefined })
  }

  function commitMetrics() {
    const obj: Record<string, string> = {}
    for (const { k, v } of metrics) {
      const key = k.trim()
      if (key) obj[key] = v
    }
    commit({ metrics: Object.keys(obj).length ? obj : undefined })
  }
  function addMetric() {
    metrics = [...metrics, { k: '', v: '' }]
  }
  function removeMetric(i: number) {
    metrics = metrics.filter((_, idx) => idx !== i)
    commitMetrics()
  }

  // Fields editor — mirrors the metrics pattern: a local row mirror the form
  // owns while editing, flushed to a clean DiagramField[] on every change.
  // Nameless rows are dropped from the commit (kept locally so a half-typed row
  // doesn't vanish), and empty optional values are stripped so they don't
  // persist as empty strings.
  function commitFields() {
    const clean: DiagramField[] = []
    for (const f of fields) {
      const name = f.name.trim()
      if (!name) continue
      const row: DiagramField = { name }
      const type = f.type?.trim()
      if (type) row.type = type
      if (f.key) row.key = f.key
      if (f.nullable) row.nullable = true
      const ref = f.ref?.trim()
      if (ref) row.ref = ref
      clean.push(row)
    }
    commit({ fields: clean.length ? clean : undefined })
  }
  function addField() {
    fields = [...fields, { name: '' }]
  }
  function removeField(i: number) {
    fields = fields.filter((_, idx) => idx !== i)
    commitFields()
  }
  function cycleFieldKey(i: number) {
    const cur = FIELD_KEY_CYCLE.indexOf(fields[i].key)
    fields[i].key = FIELD_KEY_CYCLE[(cur + 1) % FIELD_KEY_CYCLE.length]
    commitFields()
  }

  function onChipKeydown(e: KeyboardEvent, add: () => void) {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      add()
    }
  }

  const showFooter = $derived(canDetail && !!onOpenDetail)
</script>

<DiagramDrawerShell
  title={isGroup ? 'Edit group' : 'Edit node'}
  ariaLabel="Edit {isGroup ? 'group' : 'node'}: {node.label}"
  statusColor={statusColor}
  {autoFocus}
  {onClose}
  footer={showFooter ? footerContent : undefined}
>
    <!-- Label -->
    <label class="diagram-drawer__field">
      <span class="diagram-drawer__label">Label</span>
      <input
        class="diagram-drawer__input diagram-drawer__name-input"
        bind:value={label}
        oninput={onLabelInput}
        placeholder="Node label"
      />
    </label>

    <!-- Subtitle -->
    {#if !isGroup}
      <label class="diagram-drawer__field">
        <span class="diagram-drawer__label">Subtitle</span>
        <input
          class="diagram-drawer__input"
          bind:value={subtitle}
          oninput={onSubtitleInput}
          placeholder="Optional subtitle"
        />
      </label>
    {/if}

    <!-- Icon -->
    <div class="diagram-drawer__field">
      <span class="diagram-drawer__label">Icon</span>
      <IconPicker value={node.icon} onChange={(icon) => commit({ icon })} />
    </div>

    <!-- Color -->
    <div class="diagram-drawer__field">
      <span class="diagram-drawer__label">Color</span>
      <div class="diagram-node-color" role="group" aria-label="Node color">
        {#each COLORS as { value, label: colorLabel, swatch }}
          <button
            type="button"
            class="diagram-node-color__swatch"
            class:diagram-node-color__swatch--active={node.color === value}
            style="--swatch: {swatch}"
            aria-pressed={node.color === value}
            aria-label={colorLabel}
            title={colorLabel}
            onclick={() => commit({ color: value })}
          ></button>
        {/each}
        <label
          class="diagram-node-color__swatch diagram-node-color__swatch--custom"
          class:diagram-node-color__swatch--active={isCustomColor}
          style="--swatch: {isCustomColor ? node.color : 'transparent'}"
          title="Custom color"
        >
          <input
            type="color"
            class="diagram-node-color__custom-input"
            value={node.color ?? '#d97757'}
            oninput={(e) => commit({ color: e.currentTarget.value })}
            aria-label="Custom color"
          />
        </label>
      </div>
    </div>

    {#if !isGroup}
    <!-- Shape -->
    <div class="diagram-drawer__field">
      <span class="diagram-drawer__label">Shape</span>
      <div class="diagram-shape" role="group" aria-label="Node shape">
        {#each shapeOptions as { value, label: shapeLabel }}
          <button
            type="button"
            class="diagram-shape__btn"
            class:diagram-shape__btn--active={activeShape === value}
            aria-pressed={activeShape === value}
            aria-label={shapeLabel}
            title={shapeLabel}
            onclick={() => commit({ shape: value === 'rectangle' ? undefined : value })}
          >
            <span class="diagram-shape__preview diagram-shape__preview--{value}"></span>
            <span class="diagram-shape__name">{shapeLabel}</span>
          </button>
        {/each}
      </div>
    </div>

    <!-- Status -->
    <label class="diagram-drawer__field">
      <span class="diagram-drawer__label">Status</span>
      <div class="diagram-drawer__select-wrap">
        <button
          type="button"
          bind:this={statusTriggerEl}
          bind:clientWidth={statusTriggerW}
          class="diagram-drawer__select"
          aria-haspopup="listbox"
          aria-expanded={statusMenuOpen}
          onclick={() => (statusMenuOpen = !statusMenuOpen)}
        >
          {status || 'none'}
        </button>
        <svg class="diagram-drawer__select-chevron" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 6.5l4 4 4-4" />
        </svg>
        <Dropdown
          bind:open={statusMenuOpen}
          triggerEl={statusTriggerEl}
          align="top"
          width={statusTriggerW}
        >
          <div class="py-1">
            <DropdownItem
              selected={status === ''}
              onclick={() => {
                status = ''
                onStatusChange()
                statusMenuOpen = false
              }}
            >
              none
            </DropdownItem>
            {#each STATUSES as s}
              <DropdownItem
                selected={status === s}
                onclick={() => {
                  status = s
                  onStatusChange()
                  statusMenuOpen = false
                }}
              >
                {s}
              </DropdownItem>
            {/each}
          </div>
        </Dropdown>
      </div>
    </label>

    <!-- Badges -->
    <div class="diagram-drawer__field">
      <span class="diagram-drawer__label">Badges</span>
      {#if badges.length}
        <div class="diagram-drawer__chips">
          {#each badges as badge, i}
            <span class="diagram-drawer__chip">
              {badge}
              <button type="button" class="diagram-drawer__chip-x" onclick={() => removeBadge(i)} aria-label="Remove badge {badge}">✕</button>
            </span>
          {/each}
        </div>
      {/if}
      <input
        class="diagram-drawer__input"
        bind:value={badgeDraft}
        onkeydown={(e) => onChipKeydown(e, addBadge)}
        placeholder="Add badge, press Enter"
      />
    </div>

    <!-- Tags -->
    <div class="diagram-drawer__field">
      <span class="diagram-drawer__label">Tags</span>
      {#if tags.length}
        <div class="diagram-drawer__chips">
          {#each tags as tag, i}
            <span class="diagram-drawer__chip diagram-drawer__chip--tag">
              {tag}
              <button type="button" class="diagram-drawer__chip-x" onclick={() => removeTag(i)} aria-label="Remove tag {tag}">✕</button>
            </span>
          {/each}
        </div>
      {/if}
      <input
        class="diagram-drawer__input"
        bind:value={tagDraft}
        onkeydown={(e) => onChipKeydown(e, addTag)}
        placeholder="Add tag, press Enter"
      />
    </div>

    <!-- Metrics -->
    <div class="diagram-drawer__field">
      <span class="diagram-drawer__label">Metrics</span>
      {#each metrics as metric, i}
        <div class="diagram-drawer__metric-edit">
          <input
            class="diagram-drawer__input diagram-drawer__input--key"
            bind:value={metric.k}
            oninput={commitMetrics}
            placeholder="Key"
          />
          <input
            class="diagram-drawer__input"
            bind:value={metric.v}
            oninput={commitMetrics}
            placeholder="Value"
          />
          <button type="button" class="diagram-drawer__icon-btn" onclick={() => removeMetric(i)} aria-label="Remove metric">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 8h8" /></svg>
          </button>
        </div>
      {/each}
      <button type="button" class="diagram-drawer__add-row" onclick={addMetric}>
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 4v8M4 8h8" /></svg>
        Add metric
      </button>
    </div>

    <!-- Fields (data-model entity columns) -->
    <div class="diagram-drawer__field">
      <span class="diagram-drawer__label">Fields</span>
      {#each fields as field, i}
        <div class="flex flex-col gap-1.5 rounded-lg border border-[var(--solus-tool-border)] p-2">
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              class="shrink-0 w-9 h-[1.625rem] rounded-md border text-[0.625rem] font-bold tabular-nums cursor-pointer transition-colors"
              style={
                field.key
                  ? 'color:var(--solus-accent);background:color-mix(in srgb,var(--solus-accent) 12%,transparent);border-color:color-mix(in srgb,var(--solus-accent) 24%,transparent)'
                  : 'color:var(--solus-text-tertiary);border-color:var(--solus-tool-border)'
              }
              onclick={() => cycleFieldKey(i)}
              title="Key: none → PK → FK → unique"
              aria-label="Field key: {field.key ?? 'none'}"
            >{field.key ? FIELD_KEY_GLYPH[field.key] : '—'}</button>
            <input
              class="diagram-drawer__input"
              bind:value={field.name}
              oninput={commitFields}
              onkeydown={(e) => onChipKeydown(e, addField)}
              placeholder="Column name"
            />
            <button type="button" class="diagram-drawer__icon-btn" onclick={() => removeField(i)} aria-label="Remove field">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 8h8" /></svg>
            </button>
          </div>
          <div class="flex items-center gap-1.5">
            <input
              class="diagram-drawer__input"
              bind:value={field.type}
              oninput={commitFields}
              placeholder="Type"
            />
            <input
              class="diagram-drawer__input"
              bind:value={field.ref}
              oninput={commitFields}
              placeholder="Ref, e.g. users.id"
            />
            <label class="flex shrink-0 items-center gap-1 text-[0.6875rem] text-[var(--solus-text-secondary)] cursor-pointer select-none">
              <input
                type="checkbox"
                bind:checked={field.nullable}
                onchange={commitFields}
                class="accent-[var(--solus-accent)] cursor-pointer"
              />
              null
            </label>
          </div>
        </div>
      {/each}
      <button type="button" class="diagram-drawer__add-row" onclick={addField}>
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 4v8M4 8h8" /></svg>
        Add field
      </button>
    </div>

    <!-- Body -->
    <label class="diagram-drawer__field">
      <span class="diagram-drawer__label">Body</span>
      <textarea
        class="diagram-drawer__textarea"
        bind:value={body}
        oninput={onBodyInput}
        rows="4"
        placeholder="Optional description"
      ></textarea>
    </label>

    <!-- Click action -->
    <div class="diagram-drawer__field">
      <span class="diagram-drawer__label">On click</span>
      <div class="diagram-drawer__select-wrap">
        <button
          type="button"
          bind:this={clickTriggerEl}
          bind:clientWidth={clickTriggerW}
          class="diagram-drawer__select"
          aria-haspopup="listbox"
          aria-expanded={clickMenuOpen}
          onclick={() => (clickMenuOpen = !clickMenuOpen)}
        >
          {clickLabel}
        </button>
        <svg class="diagram-drawer__select-chevron" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 6.5l4 4 4-4" />
        </svg>
        <Dropdown
          bind:open={clickMenuOpen}
          triggerEl={clickTriggerEl}
          align="top"
          width={clickTriggerW}
        >
          <div class="py-1">
            {#each CLICK_OPTIONS as opt (opt.value)}
              <DropdownItem
                selected={clickKind === opt.value}
                onclick={() => {
                  clickKind = opt.value
                  onClickKindChange()
                  clickMenuOpen = false
                }}
              >
                {opt.label}
              </DropdownItem>
            {/each}
          </div>
        </Dropdown>
      </div>
      {#if clickKind === 'openUrl'}
        <input
          class="diagram-drawer__input"
          bind:value={clickValue}
          oninput={commitAction}
          placeholder="https://…"
        />
      {/if}
    </div>
    {/if}
</DiagramDrawerShell>

{#snippet footerContent()}
    {#if canDetail && onOpenDetail}
      <div class="diagram-drawer__detail-row">
        <button
          type="button"
          class="diagram-btn diagram-btn--ghost diagram-drawer__detail-btn"
          onclick={() => onOpenDetail?.()}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2" y="2.5" width="7" height="5" rx="1" />
            <rect x="7" y="8.5" width="7" height="5" rx="1" />
            <path d="M5.5 7.5v1.5a1 1 0 001 1h1" />
          </svg>
          {hasDetail ? 'Open detail diagram' : 'Add detail diagram'}
        </button>
        {#if hasDetail && onRemoveDetail}
          <button
            type="button"
            class="diagram-drawer__icon-btn diagram-drawer__detail-remove"
            onclick={() => onRemoveDetail?.()}
            title="Remove detail diagram"
            aria-label="Remove detail diagram"
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 4.5h10M6.5 4.5V3a1 1 0 011-1h1a1 1 0 011 1v1.5" />
              <path d="M4 4.5l.5 8.5a1 1 0 001 1h5a1 1 0 001-1l.5-8.5" />
            </svg>
          </button>
        {/if}
      </div>
    {/if}
{/snippet}

<style>
  /* Chrome (container, header, content, footer, field/label/input primitives and
     .diagram-btn) lives in DiagramDrawerShell. Only the node-specific field
     controls below are scoped here. */
  .diagram-drawer__select-wrap {
    position: relative;
    display: flex;
  }

  .diagram-drawer__select {
    cursor: pointer;
    text-transform: capitalize;
    text-align: left;
    /* Drop the native arrow so we can place a perfectly centred custom one. */
    appearance: none;
    -webkit-appearance: none;
    padding-right: 1.75rem;
  }

  .diagram-drawer__select-chevron {
    position: absolute;
    right: 0.5rem;
    top: 50%;
    transform: translateY(-50%);
    color: var(--solus-text-tertiary);
    pointer-events: none;
  }

  .diagram-drawer__textarea {
    resize: vertical;
    line-height: 1.5;
    min-height: 4.5rem;
  }

  /* Colour swatches — mirrors the edge drawer's palette control. */
  .diagram-node-color {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4375rem;
  }

  .diagram-node-color__swatch {
    flex-shrink: 0;
    width: 1.375rem;
    height: 1.375rem;
    padding: 0;
    border-radius: 50%;
    border: 0.0625rem solid color-mix(in srgb, var(--solus-text-primary) 14%, transparent);
    background: var(--swatch);
    cursor: pointer;
    transition: transform 0.12s ease, box-shadow 0.12s ease;
  }

  .diagram-node-color__swatch:hover {
    transform: scale(1.12);
  }

  .diagram-node-color__swatch--active {
    box-shadow:
      0 0 0 0.125rem var(--solus-container-bg),
      0 0 0 0.21875rem var(--swatch);
  }

  .diagram-node-color__swatch:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  .diagram-node-color__swatch--custom {
    position: relative;
    display: inline-grid;
    place-items: center;
    overflow: hidden;
    background:
      conic-gradient(
        from 90deg,
        #f87171,
        #fbbf24,
        #4ade80,
        #60a5fa,
        #a78bfa,
        #f87171
      );
  }

  .diagram-node-color__swatch--custom.diagram-node-color__swatch--active {
    background: var(--swatch);
  }

  .diagram-node-color__swatch--custom:focus-within {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  .diagram-node-color__custom-input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    border: none;
    opacity: 0;
    cursor: pointer;
  }

  /* Shape picker — a small grid of outline previews mirroring the colour row. */
  .diagram-shape {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.375rem;
  }

  .diagram-shape__btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0.5rem 0.25rem;
    border: 0.0625rem solid var(--solus-tool-border);
    border-radius: 0.5rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition: border-color 0.12s ease, color 0.12s ease, background 0.12s ease;
  }

  .diagram-shape__btn:hover {
    border-color: var(--solus-accent-border);
    color: var(--solus-text-secondary);
  }

  .diagram-shape__btn--active {
    border-color: var(--solus-accent);
    color: var(--solus-accent);
    background: color-mix(in srgb, var(--solus-accent) 8%, transparent);
  }

  .diagram-shape__btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }

  /* The preview is a small block tinted to the current colour, clipped/rounded
     to match the shape it represents. */
  .diagram-shape__preview {
    width: 1.5rem;
    height: 1.125rem;
    background: currentColor;
    opacity: 0.85;
  }
  .diagram-shape__preview--rectangle { border-radius: 0.25rem; }
  /* Circle and diamond read best from a square preview. */
  .diagram-shape__preview--circle {
    width: 1.125rem;
    border-radius: 50%;
  }
  .diagram-shape__preview--diamond {
    width: 1.125rem;
    clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
  }

  .diagram-shape__name {
    font-size: 0.625rem;
    font-weight: 500;
    line-height: 1;
  }

  .diagram-drawer__chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3125rem;
  }

  .diagram-drawer__chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    padding: 0.125rem 0.25rem 0.125rem 0.5rem;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--solus-accent) 10%, transparent);
    border: 0.0625rem solid color-mix(in srgb, var(--solus-accent) 20%, transparent);
    color: var(--solus-text-secondary);
    font-size: 0.6875rem;
    font-weight: 500;
  }

  .diagram-drawer__chip--tag {
    background: transparent;
    border-color: color-mix(in srgb, var(--solus-text-tertiary) 22%, transparent);
    color: var(--solus-text-tertiary);
  }

  .diagram-drawer__chip-x {
    display: grid;
    place-items: center;
    width: 0.875rem;
    height: 0.875rem;
    border: none;
    border-radius: 0.25rem;
    background: transparent;
    color: inherit;
    font-size: 0.5625rem;
    cursor: pointer;
    opacity: 0.7;
    transition: opacity 0.12s ease, background 0.12s ease;
  }

  .diagram-drawer__chip-x:hover {
    opacity: 1;
    background: color-mix(in srgb, #f87171 18%, transparent);
    color: #f87171;
  }

  .diagram-drawer__metric-edit {
    display: flex;
    gap: 0.375rem;
    align-items: center;
  }

  .diagram-drawer__input--key {
    flex: 0 0 7rem;
  }

  .diagram-drawer__icon-btn {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 1.625rem;
    height: 1.625rem;
    border: 0.0625rem solid var(--solus-tool-border);
    border-radius: 0.5rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition: color 0.12s ease, border-color 0.12s ease;
  }

  .diagram-drawer__icon-btn:hover {
    color: #f87171;
    border-color: color-mix(in srgb, #f87171 40%, transparent);
  }

  .diagram-drawer__add-row {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    align-self: flex-start;
    padding: 0.25rem 0.5rem;
    border: 0.0625rem dashed var(--solus-tool-border);
    border-radius: 0.5rem;
    background: transparent;
    color: var(--solus-text-secondary);
    font-size: 0.6875rem;
    font-weight: 500;
    cursor: pointer;
    transition: border-color 0.12s ease, color 0.12s ease;
  }

  .diagram-drawer__add-row:hover {
    border-color: var(--solus-accent-border);
    color: var(--solus-accent);
  }

  /* Footer / CTA — the footer wrapper itself is provided by DiagramDrawerShell. */
  .diagram-drawer__detail-btn {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    padding: 0.4375rem 0.75rem;
    font-size: 0.75rem;
  }

  .diagram-drawer__detail-row {
    display: flex;
    gap: 0.375rem;
  }

  /* The open button flexes; the remove button stays a fixed square beside it. */
  .diagram-drawer__detail-row .diagram-drawer__detail-btn {
    flex: 1;
    min-width: 0;
    width: auto;
  }

  .diagram-drawer__detail-remove {
    width: 2.125rem;
    height: auto;
    align-self: stretch;
  }
</style>
