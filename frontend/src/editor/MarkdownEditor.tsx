import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { useEffect, useEffectEvent, useRef } from 'react'

import { dictionaryHover } from './dictionaryHover'
import { liveMarkdown } from './liveMarkdown'


interface MarkdownEditorProps {
  initialDocument: string
  onChange: (document: string) => void
  onSave: () => void
  onSelectWord: (word: string | null) => void
  live?: boolean
}

export function MarkdownEditor({ initialDocument, onChange, onSave, onSelectWord, live = false }: MarkdownEditorProps) {
  const container = useRef<HTMLDivElement>(null)
  const handleChange = useEffectEvent(onChange)
  const handleSave = useEffectEvent(onSave)
  const handleSelectWord = useEffectEvent(onSelectWord)

  useEffect(() => {
    if (!container.current) return
    const state = EditorState.create({
      doc: initialDocument,
      extensions: [
        lineNumbers(),
        history(),
        markdown(),
        ...(live ? [liveMarkdown] : []),
        dictionaryHover,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) handleChange(update.state.doc.toString())
          if (update.selectionSet) {
            const selection = update.state.selection.main
            const selected = selection.empty
              ? null
              : update.state.sliceDoc(selection.from, selection.to).trim()
            handleSelectWord(
              selected && /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u.test(selected)
                ? selected
                : null,
            )
          }
        }),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { handleSave(); return true } },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.theme({
          '&': { height: '100%', fontSize: '14px', backgroundColor: '#fbfcfa' },
          '.cm-scroller': { overflow: 'auto', fontFamily: '"IBM Plex Mono", Consolas, monospace' },
          '.cm-content': { padding: '20px 0', caretColor: '#1d604d' },
          '.cm-line': { padding: '0 22px' },
          '.cm-gutters': { backgroundColor: '#f2f5f1', color: '#89938e', border: '0' },
          '&.cm-focused': { outline: 'none' },
          '&.cm-focused .cm-cursor': { borderLeftColor: '#1d604d' },
          '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#edf3ee' },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#cfe1d5' },
        }),
      ],
    })
    const view = new EditorView({ state, parent: container.current })
    return () => view.destroy()
  }, [initialDocument, live])

  return <div className="markdown-editor" ref={container} />
}