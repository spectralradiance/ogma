import { history, redo, undo } from '@codemirror/commands'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { acceptSpec, proposeSpec, rejectSpec, suggestionField, suggestionsOf } from './suggestions'

const BEFORE = 'The night was cold.\nStars came out.\nWe went home.'
const AFTER = 'The night was bitter.\nStars came out slowly.\nWe went home.'

const create = (doc = BEFORE) => EditorState.create({ doc, extensions: [history(), suggestionField] })
const apply = (state: EditorState, spec: TransactionSpec | null) => (spec ? state.update(spec).state : state)
const propose = (state: EditorState, target = AFTER) => apply(state, proposeSpec(state, target, 'Draft'))

// Runs an undo/redo command against a state and returns the resulting state.
function command(state: EditorState, run: typeof undo): EditorState {
  let result = state
  run({ state, dispatch: (tr) => { result = tr.state } })
  return result
}

describe('suggestions', () => {
  it('leave the text alone until accepted', () => {
    const state = propose(create())
    expect(state.doc.toString()).toBe(BEFORE)
    expect(suggestionsOf(state).map((item) => item.insert)).toEqual(['bitter', ' slowly'])
  })

  it('accept all reaches the proposed text; reject all keeps the original', () => {
    const state = propose(create())
    expect(apply(state, acceptSpec(state)).doc.toString()).toBe(AFTER)
    const rejected = apply(state, rejectSpec(state))
    expect(rejected.doc.toString()).toBe(BEFORE)
    expect(suggestionsOf(rejected)).toHaveLength(0)
  })

  it('accepting one keeps the others in the right place', () => {
    let state = propose(create())
    const [first, second] = suggestionsOf(state)
    state = apply(state, acceptSpec(state, [first.id]))
    expect(state.doc.toString()).toBe('The night was bitter.\nStars came out.\nWe went home.')
    expect(suggestionsOf(state).map((item) => item.id)).toEqual([second.id])
    state = apply(state, acceptSpec(state))
    expect(state.doc.toString()).toBe(AFTER)
  })

  it('follow typing elsewhere and drop when edited over', () => {
    let state = propose(create())
    state = state.update({ changes: { from: 0, insert: 'Oh. ' } }).state
    expect(apply(state, acceptSpec(state)).doc.toString()).toBe(`Oh. ${AFTER}`)
    // "cold" is what the first suggestion replaces; typing inside it drops that one only.
    const cold = state.doc.toString().indexOf('cold')
    state = state.update({ changes: { from: cold + 1, to: cold + 2, insert: 'O' } }).state
    expect(suggestionsOf(state).map((item) => item.insert)).toEqual([' slowly'])
  })

  it('come back when an accept or reject is undone', () => {
    let state = propose(create())
    state = apply(state, acceptSpec(state))
    expect(suggestionsOf(state)).toHaveLength(0)
    state = command(state, undo)
    expect(state.doc.toString()).toBe(BEFORE)
    expect(suggestionsOf(state)).toHaveLength(2)
    state = command(state, redo)
    expect(state.doc.toString()).toBe(AFTER)
    expect(suggestionsOf(state)).toHaveLength(0)

    let rejected = propose(create())
    rejected = apply(rejected, rejectSpec(rejected))
    rejected = command(rejected, undo)
    expect(suggestionsOf(rejected)).toHaveLength(2)
  })
})
