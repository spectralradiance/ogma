import { invertedEffects } from '@codemirror/commands'
import { type ChangeDesc, type EditorState, StateEffect, StateField, type Transaction, type TransactionSpec } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, type Panel, showPanel, WidgetType } from '@codemirror/view'

import { suggestEdits, type TextEdit } from '../../../shared/diff'

/**
 * Suggest mode: proposed edits shown in place without changing the text. A
 * deletion is struck through, an insertion is shown after it, and each carries
 * accept / reject buttons; a bar offers accept all and reject all. Accepting is
 * an ordinary, undoable edit. Suggestions follow the text as the writer types,
 * and one the writer edits over is dropped.
 */

export interface Suggestion extends TextEdit {
  id: number
}

interface SuggestionState {
  items: readonly Suggestion[]
  /** What proposed them, for the bar ("Draft output · Constellations"). */
  label: string
}

const setSuggestions = StateEffect.define<{ items: Suggestion[]; label: string }>()
const resolveSuggestions = StateEffect.define<readonly number[]>({ map: (ids) => ids })
// Brings resolved suggestions back when an accept or reject is undone.
const restoreSuggestions = StateEffect.define<{ items: Suggestion[]; label: string }>({
  map: (value, mapping: ChangeDesc) => ({
    ...value,
    items: value.items.map((item) => ({ ...item, from: mapping.mapPos(item.from, -1), to: mapping.mapPos(item.to, item.from === item.to ? -1 : 1) })),
  }),
})

let nextId = 1

const EMPTY: SuggestionState = { items: [], label: '' }

/** Moves suggestions through a change, dropping any the change edited inside. */
function mapItems(items: readonly Suggestion[], tr: Transaction): Suggestion[] {
  const kept: Suggestion[] = []
  for (const item of items) {
    let hit = false
    tr.changes.iterChangedRanges((fromA, toA) => {
      // Typing right at either edge leaves the suggestion alone; touching what it covers drops it.
      if (item.from === item.to ? fromA < item.from && toA > item.from : fromA < item.to && toA > item.from) hit = true
    })
    if (hit) continue
    const from = tr.changes.mapPos(item.from, item.from === item.to ? -1 : 1)
    const to = item.from === item.to ? from : Math.max(from, tr.changes.mapPos(item.to, -1))
    kept.push({ ...item, from, to })
  }
  return kept
}

export const suggestionField = StateField.define<SuggestionState>({
  create: () => EMPTY,
  update(value, tr) {
    let next = value
    if (tr.docChanged && next.items.length) next = { ...next, items: mapItems(next.items, tr) }
    for (const effect of tr.effects) {
      if (effect.is(setSuggestions)) next = effect.value
      if (effect.is(resolveSuggestions)) {
        const done = new Set(effect.value)
        next = { ...next, items: next.items.filter((item) => !done.has(item.id)) }
      }
      if (effect.is(restoreSuggestions)) {
        next = { label: next.items.length ? next.label : effect.value.label, items: [...next.items, ...effect.value.items].sort((a, b) => a.from - b.from) }
      }
    }
    return next.items.length ? next : EMPTY
  },
  provide: (field) => [
    invertedEffects.of((tr) => {
      const inverted: StateEffect<unknown>[] = []
      for (const effect of tr.effects) {
        if (effect.is(resolveSuggestions)) {
          const before = tr.startState.field(field)
          const items = before.items.filter((item) => effect.value.includes(item.id))
          if (items.length) inverted.push(restoreSuggestions.of({ items, label: before.label }))
        }
        if (effect.is(restoreSuggestions)) inverted.push(resolveSuggestions.of(effect.value.items.map((item) => item.id)))
      }
      return inverted
    }),
    EditorView.decorations.compute([field], decorate),
    showPanel.from(field, (value) => (value.items.length ? suggestionPanel : null)),
  ],
})

/**
 * The transaction that shows the edits turning the whole text into `target` as
 * suggestions, replacing any already shown.
 */
export function proposeSpec(state: EditorState, target: string, label: string): TransactionSpec & { count: number } {
  const items = suggestEdits(state.doc.toString(), target).map((edit) => ({ ...edit, id: nextId++ }))
  const effects: StateEffect<unknown>[] = [setSuggestions.of({ items, label })]
  if (items.length) effects.push(EditorView.scrollIntoView(items[0].from, { y: 'center' }))
  return { effects, count: items.length }
}

/** Shows `target` as suggestions against the current text; returns how many. */
export function proposeText(view: EditorView, target: string, label: string): number {
  const { count, ...spec } = proposeSpec(view.state, target, label)
  view.dispatch(spec)
  return count
}

export function suggestionsOf(state: EditorState): readonly Suggestion[] {
  return state.field(suggestionField, false)?.items ?? []
}

const pick = (state: EditorState, ids?: readonly number[]) => suggestionsOf(state).filter((item) => !ids || ids.includes(item.id))

/** Applies the given suggestions (all when no ids) as one undoable edit, or null if there are none. */
export function acceptSpec(state: EditorState, ids?: readonly number[]): TransactionSpec | null {
  const items = pick(state, ids)
  if (!items.length) return null
  return {
    changes: items.map(({ from, to, insert }) => ({ from, to, insert })),
    effects: resolveSuggestions.of(items.map((item) => item.id)),
    userEvent: 'input.suggestion',
  }
}

/** Drops the given suggestions (all when no ids), or null if there are none. */
export function rejectSpec(state: EditorState, ids?: readonly number[]): TransactionSpec | null {
  const items = pick(state, ids)
  return items.length ? { effects: resolveSuggestions.of(items.map((item) => item.id)) } : null
}

export function acceptSuggestions(view: EditorView, ids?: readonly number[]): void {
  const spec = acceptSpec(view.state, ids)
  if (spec) view.dispatch(spec)
}

export function rejectSuggestions(view: EditorView, ids?: readonly number[]): void {
  const spec = rejectSpec(view.state, ids)
  if (spec) view.dispatch(spec)
}

/**
 * The inserted text (if any) with the accept / reject buttons. Line breaks at the end of
 * the insertion come after the buttons, so they sit with the text they belong to.
 */
class SuggestionWidget extends WidgetType {
  readonly id: number
  readonly insert: string

  constructor(id: number, insert: string) {
    super()
    this.id = id
    this.insert = insert
  }

  eq(other: SuggestionWidget): boolean {
    return other.id === this.id && other.insert === this.insert
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('span')
    const body = this.insert.replace(/\n+$/, '')
    if (body) {
      const inserted = document.createElement('span')
      inserted.className = 'cm-suggest-insert'
      inserted.textContent = body
      box.append(inserted)
    }
    const controls = document.createElement('span')
    controls.className = 'cm-suggest-controls'
    const button = (label: string, title: string, run: () => void) => {
      const element = document.createElement('button')
      element.type = 'button'
      element.textContent = label
      element.title = title
      element.setAttribute('aria-label', title)
      // mousedown, so the click neither moves the cursor nor steals focus first.
      element.addEventListener('mousedown', (event) => {
        event.preventDefault()
        run()
      })
      return element
    }
    controls.append(
      button('✓', 'Accept this change', () => acceptSuggestions(view, [this.id])),
      button('✕', 'Reject this change', () => rejectSuggestions(view, [this.id])),
    )
    box.append(controls)
    if (body.length < this.insert.length) {
      const breaks = document.createElement('span')
      breaks.className = 'cm-suggest-insert-breaks'
      breaks.textContent = this.insert.slice(body.length)
      box.append(breaks)
    }
    return box
  }

  ignoreEvent(): boolean {
    return true
  }
}

function decorate(state: EditorState): DecorationSet {
  const ranges = []
  for (const item of state.field(suggestionField).items) {
    if (item.to > item.from) ranges.push(Decoration.mark({ class: 'cm-suggest-delete' }).range(item.from, item.to))
    // After a removed paragraph, show the buttons at the end of its text rather than on the next line.
    const removed = state.sliceDoc(item.from, item.to)
    const anchor = item.to - (removed.length - removed.replace(/\n+$/, '').length)
    ranges.push(Decoration.widget({ widget: new SuggestionWidget(item.id, item.insert), side: 1 }).range(anchor))
  }
  return Decoration.set(ranges, true)
}

function suggestionPanel(view: EditorView): Panel {
  const dom = document.createElement('div')
  dom.className = 'cm-suggest-bar'
  const text = document.createElement('span')
  text.className = 'cm-suggest-bar-text'
  const action = (label: string, run: () => void, primary = false) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    if (primary) button.className = 'primary'
    button.addEventListener('click', run)
    return button
  }
  const jump = action('Next', () => {
    const items = suggestionsOf(view.state)
    const head = view.state.selection.main.head
    const target = items.find((item) => item.from > head) ?? items[0]
    if (target) view.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: 'center' }) })
    view.focus()
  })
  dom.append(text, jump, action('Reject all', () => rejectSuggestions(view)), action('Accept all', () => acceptSuggestions(view), true))
  const render = (state: EditorState) => {
    const value = state.field(suggestionField)
    const count = value.items.length
    text.textContent = `${count} suggested change${count === 1 ? '' : 's'}${value.label ? ` · ${value.label}` : ''}`
  }
  render(view.state)
  return {
    dom,
    top: true,
    update: (update) => render(update.state),
  }
}

export const suggestions = [
  suggestionField,
  EditorView.theme({
    '.cm-suggest-delete': {
      textDecoration: 'line-through',
      textDecorationColor: 'var(--bad)',
      backgroundColor: 'color-mix(in srgb, var(--bad) 14%, transparent)',
    },
    '.cm-suggest-insert': {
      whiteSpace: 'pre-wrap',
      textDecoration: 'underline',
      textDecorationColor: 'var(--ok)',
      backgroundColor: 'color-mix(in srgb, var(--ok) 18%, transparent)',
    },
    '.cm-suggest-insert-breaks': { whiteSpace: 'pre-wrap' },
    '.cm-suggest-controls': {
      display: 'inline-flex',
      gap: '2px',
      margin: '0 2px',
      verticalAlign: 'text-bottom',
      fontFamily: 'var(--font-ui)',
    },
    '.cm-suggest-controls button': {
      padding: '0 5px',
      fontSize: '11px',
      lineHeight: '16px',
      color: 'var(--muted)',
      background: 'var(--raised)',
      border: '1px solid var(--border)',
      borderRadius: '3px',
      cursor: 'pointer',
    },
    '.cm-suggest-controls button:hover': { color: 'var(--text)', borderColor: 'var(--accent)' },
    '.cm-suggest-bar': {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '6px 12px',
      backgroundColor: 'var(--surface)',
      borderBottom: '1px solid var(--border)',
      fontFamily: 'var(--font-ui)',
      fontSize: '12px',
    },
    '.cm-suggest-bar-text': { marginRight: 'auto', color: 'var(--muted)' },
  }),
]
