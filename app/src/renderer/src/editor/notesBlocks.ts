import { type EditorState, type Extension, Facet, Prec, type Range, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from '@codemirror/view'

import { planNotes, sectionLevel } from '../../../shared/document'
import { classifyLines, type LineRole } from '../../../shared/notes'
import { extractHeadings } from '../../../shared/text'

/**
 * Notes inside a document: `::: notes` … `:::` blocks under the section they
 * belong to. One editor shows the file three ways:
 *
 * - `output`: the text alone, read as one continuous document (notes hidden)
 * - `notes`: the notes alone, as one continuous document under the section headings
 * - `all`: both, with each notes block drawn as a quieter, indented block
 *
 * Hiding never changes the text; edits in either view go straight into the file.
 */

export type NotesView = 'output' | 'notes' | 'all'

export const notesView = Facet.define<NotesView, NotesView>({ combine: (values) => values.at(-1) ?? 'all' })

/** Replace the marker lines with a label while the cursor is elsewhere (set by live rendering). */
export const notesMarkersCollapse = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) })

/** Fired on the editor's element when a command needs the notes view (adding notes from the output view). */
export const SHOW_NOTES_EVENT = 'ogma:show-notes'

interface Block {
  /** 1-based line numbers; `close` equals the last line when the block is never closed. */
  open: number
  close: number
  closed: boolean
}

interface Structure {
  roles: LineRole[]
  blocks: Block[]
  /** 1-based lines of the section headings. */
  sections: Set<number>
}

function analyze(state: EditorState): Structure {
  const lines: string[] = []
  for (const line of state.doc.iterLines()) lines.push(line)
  const roles = classifyLines(lines)
  const blocks: Block[] = []
  let current: Block | null = null
  roles.forEach((role, index) => {
    if (role === 'open') {
      current = { open: index + 1, close: lines.length, closed: false }
      blocks.push(current)
    } else if (role === 'close' && current) {
      current.close = index + 1
      current.closed = true
      current = null
    }
  })
  const headings = extractHeadings(lines.join('\n'))
  const level = sectionLevel(headings)
  return { roles, blocks, sections: new Set(headings.filter((heading) => heading.level === level).map((heading) => heading.line)) }
}

class LabelWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const label = document.createElement('span')
    label.className = 'cm-notes-label'
    label.textContent = 'Notes'
    return label
  }
}

const label = new LabelWidget()
const hide = Decoration.replace({})
const hideLines = Decoration.replace({ block: true })

function build(state: EditorState, structure: Structure): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const doc = state.doc
  const view = state.facet(notesView)
  const { roles, blocks, sections } = structure
  // Hides lines first..last (1-based, inclusive) as one block.
  const hideRange = (first: number, last: number) => {
    decorations.push(hideLines.range(doc.line(first).from, doc.line(last).to))
  }

  if (view === 'output') {
    let previousEnd = 0
    for (const block of blocks) {
      // Take the blank line before the block with it, so the text closes up.
      const start = block.open > 1 && block.open - 1 > previousEnd && doc.line(block.open - 1).text.trim() === '' ? block.open - 1 : block.open
      hideRange(start, block.close)
      previousEnd = block.close
    }
    return Decoration.set(decorations, true)
  }

  if (view === 'notes') {
    let runStart = 0
    for (let number = 1; number <= doc.lines; number += 1) {
      const visible = roles[number - 1] === 'notes' || sections.has(number)
      if (!visible) {
        if (runStart === 0) runStart = number
        continue
      }
      if (runStart) hideRange(runStart, number - 1)
      runStart = 0
      if (roles[number - 1] === 'notes') decorations.push(Decoration.line({ class: 'cm-notes-flow' }).range(doc.line(number).from))
    }
    if (runStart) hideRange(runStart, doc.lines)
    return Decoration.set(decorations, true)
  }

  const collapse = state.facet(notesMarkersCollapse)
  for (const block of blocks) {
    const first = doc.line(block.open)
    const last = doc.line(block.close)
    const active = state.selection.ranges.some((range) => range.from <= last.to && range.to >= first.from)
    const collapsed = collapse && !active
    for (let number = block.open; number <= block.close; number += 1) {
      const line = doc.line(number)
      const classes = ['cm-notes-line']
      if (number === block.open) classes.push('cm-notes-top')
      if (number === block.close) classes.push('cm-notes-bottom')
      if (collapsed && number === block.close && block.closed) classes.push('cm-notes-close-collapsed')
      decorations.push(Decoration.line({ class: classes.join(' ') }).range(line.from))
      if (!collapsed || line.to === line.from) continue
      if (number === block.open) decorations.push(Decoration.replace({ widget: label }).range(line.from, line.to))
      else if (number === block.close && block.closed) decorations.push(hide.range(line.from, line.to))
    }
  }
  return Decoration.set(decorations, true)
}

interface NotesState {
  structure: Structure
  decorations: DecorationSet
}

const notesField = StateField.define<NotesState>({
  create(state) {
    const structure = analyze(state)
    return { structure, decorations: build(state, structure) }
  },
  update(value, transaction) {
    const facetsChanged = transaction.startState.facet(notesView) !== transaction.state.facet(notesView)
      || transaction.startState.facet(notesMarkersCollapse) !== transaction.state.facet(notesMarkersCollapse)
    // Only the full view depends on the selection (markers unfold around the cursor).
    const selectionMatters = transaction.selection !== undefined && transaction.state.facet(notesView) === 'all'
    if (!transaction.docChanged && !selectionMatters && !facetsChanged) return value
    const structure = transaction.docChanged ? analyze(transaction.state) : value.structure
    return { structure, decorations: build(transaction.state, structure) }
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
})

/** Moves the cursor out of hidden lines (after switching views), to the nearest line still shown. */
export function revealSelection(view: EditorView): void {
  const { decorations } = view.state.field(notesField)
  const head = view.state.selection.main.head
  let target = null as number | null
  decorations.between(head, head, (from, to, decoration) => {
    if (!(decoration.spec as { block?: boolean }).block || head < from || head > to) return
    target = to < view.state.doc.length ? to + 1 : Math.max(0, from - 1)
    return false
  })
  if (target !== null) view.dispatch({ selection: { anchor: target } })
}

/** Adds an empty notes block to the section at the cursor, or moves into the one it has. */
export function addOrJumpToNotes(view: EditorView): boolean {
  const state = view.state
  const plan = planNotes(state.doc.toString(), state.doc.lineAt(state.selection.main.head).number)
  if (plan.kind === 'jump') {
    const line = state.doc.line(Math.min(plan.line, state.doc.lines))
    view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true })
  } else {
    view.dispatch({
      changes: { from: plan.offset, insert: plan.insert },
      selection: { anchor: plan.cursor },
      scrollIntoView: true,
      userEvent: 'input',
    })
  }
  // Notes can't be seen in the output view; ask for the notes view.
  if (state.facet(notesView) === 'output') view.dom.dispatchEvent(new CustomEvent(SHOW_NOTES_EVENT))
  view.focus()
  return true
}

/**
 * In the notes view a new line after a section heading would be hidden output,
 * so Enter there starts (or moves into) that section's notes instead.
 */
const notesViewKeys = Prec.high(keymap.of([{
  key: 'Enter',
  run: (view) => {
    const state = view.state
    if (state.facet(notesView) !== 'notes' || !state.selection.main.empty) return false
    const line = state.doc.lineAt(state.selection.main.head)
    if (!state.field(notesField).structure.sections.has(line.number)) return false
    return addOrJumpToNotes(view)
  },
}]))

export const notesBlocks: Extension = [notesField, notesViewKeys]
