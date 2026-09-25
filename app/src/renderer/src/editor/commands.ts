import { EditorSelection, type StateCommand } from '@codemirror/state'

/**
 * Wraps each selection in `marker` (e.g. ** for bold), or unwraps it when the
 * marker already surrounds the selection. With an empty selection the markers
 * are inserted and the cursor is placed between them.
 */
export function toggleWrap(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    const size = marker.length
    dispatch(state.update(state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - size, range.from)
      const after = state.sliceDoc(range.to, range.to + size)
      if (before === marker && after === marker) {
        return {
          changes: [{ from: range.from - size, to: range.from }, { from: range.to, to: range.to + size }],
          range: EditorSelection.range(range.from - size, range.to - size),
        }
      }
      return {
        changes: [{ from: range.from, insert: marker }, { from: range.to, insert: marker }],
        range: EditorSelection.range(range.from + size, range.to + size),
      }
    }), { scrollIntoView: true, userEvent: 'input' }))
    return true
  }
}
