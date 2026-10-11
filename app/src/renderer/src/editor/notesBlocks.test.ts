import { EditorState, type Extension } from '@codemirror/state'
import { type DecorationSet, EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import { notesBlocks, notesMarkersCollapse, notesView } from './notesBlocks'

// Offsets: "# Intro" 0–7, "" 8, "text" 9–13, "" 14, "::: notes" 15–24, "a note" 25–31, ":::" 32–35, "" 36, "after" 37–42
const DOC = ['# Intro', '', 'text', '', '::: notes', 'a note', ':::', '', 'after'].join('\n')

interface Found {
  from: number
  to: number
  className: string | null
  block: boolean
}

function decorationsOf(state: EditorState): Found[] {
  const found: Found[] = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === 'function') continue
    ;(source as DecorationSet).between(0, state.doc.length, (from, to, decoration) => {
      const spec = decoration.spec as { class?: string; block?: boolean }
      found.push({ from, to, className: spec.class ?? null, block: spec.block === true })
    })
  }
  return found
}

const create = (extensions: Extension[], anchor = 0) => EditorState.create({ doc: DOC, selection: { anchor }, extensions: [notesBlocks, ...extensions] })
const replaced = (state: EditorState) => decorationsOf(state).filter((found) => found.to > found.from).map((found) => [found.from, found.to])

describe('notesBlocks, both view', () => {
  it('styles every line of a block, markers included', () => {
    const lines = decorationsOf(create([notesView.of('all')])).filter((found) => found.className?.includes('cm-notes-line'))
    expect(lines).toHaveLength(3)
    expect(lines[0].className).toContain('cm-notes-top')
    expect(lines[2].className).toContain('cm-notes-bottom')
  })

  it('folds the markers in live mode while the cursor is outside the block', () => {
    expect(replaced(create([notesView.of('all'), notesMarkersCollapse.of(true)]))).toEqual([[15, 24], [32, 35]])
  })

  it('shows the markers while the cursor is inside the block', () => {
    expect(replaced(create([notesView.of('all'), notesMarkersCollapse.of(true)], 27))).toEqual([])
  })
})

describe('notesBlocks, output view', () => {
  it('hides each notes block with the blank line before it', () => {
    const hidden = decorationsOf(create([notesView.of('output')]))
    expect(hidden).toEqual([{ from: 14, to: 35, className: null, block: true }])
  })
})

describe('notesBlocks, notes view', () => {
  it('shows only the section headings and the notes, as one flow', () => {
    const state = create([notesView.of('notes')])
    expect(decorationsOf(state).filter((found) => found.block).map((found) => [found.from, found.to])).toEqual([[8, 24], [32, 42]])
    expect(decorationsOf(state).filter((found) => found.className === 'cm-notes-flow').map((found) => found.from)).toEqual([25])
  })
})
