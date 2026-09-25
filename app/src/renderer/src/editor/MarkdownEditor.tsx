import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { drawSelection, dropCursor, EditorView, keymap, placeholder as placeholderText } from '@codemirror/view'
import { type Ref, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'

import { toggleWrap } from './commands'
import { focusMode as focusModeExtension } from './focusMode'
import { documentPath, livePreview } from './livePreview'
import { autoHeightTheme, editorTheme } from './theme'

export interface MarkdownEditorHandle {
  getText(): string
  focus(): void
  /** Puts the cursor at the start of a 1-based line and scrolls it to the top. */
  revealLine(line: number): void
}

interface MarkdownEditorProps {
  ref?: Ref<MarkdownEditorHandle>
  path: string
  initialText: string
  placeholder?: string
  /** Grow with the content instead of scrolling, for editors stacked in one scrolling document. */
  autoHeight?: boolean
  live: boolean
  focusMode: boolean
  onDocChanged: () => void
  onSave: () => void
  onBlur: () => void
  onFocus?: () => void
}

const noop = () => {}

/**
 * Uncontrolled CodeMirror editor. The parent reads the text through the handle
 * instead of receiving it on every keystroke, which keeps large notes fast.
 */
export function MarkdownEditor({
  ref, path, initialText, placeholder, autoHeight = false, live, focusMode, onDocChanged, onSave, onBlur, onFocus,
}: MarkdownEditorProps) {
  const container = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [compartments] = useState(() => ({ live: new Compartment(), focus: new Compartment() }))
  const handleDocChanged = useEffectEvent(onDocChanged)
  const handleSave = useEffectEvent(onSave)
  const handleBlur = useEffectEvent(onBlur)
  const handleFocus = useEffectEvent(onFocus ?? noop)

  useImperativeHandle(ref, () => ({
    getText: () => view.current?.state.doc.toString() ?? initialText,
    focus: () => view.current?.focus(),
    revealLine: (number) => {
      const editor = view.current
      if (!editor) return
      const line = editor.state.doc.line(Math.max(1, Math.min(number, editor.state.doc.lines)))
      editor.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 24 }),
      })
      editor.focus()
    },
  }), [initialText])

  useLayoutEffect(() => {
    if (!container.current) return
    const state = EditorState.create({
      doc: initialText,
      extensions: [
        documentPath.of(path),
        history(),
        drawSelection(),
        dropCursor(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        search({ top: true }),
        highlightSelectionMatches(),
        compartments.live.of([]),
        compartments.focus.of([]),
        editorTheme,
        autoHeight ? autoHeightTheme : ([] as Extension),
        EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'off', autocapitalize: 'off' }),
        placeholder ? placeholderText(placeholder) : [],
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { handleSave(); return true } },
          { key: 'Mod-b', run: toggleWrap('**') },
          { key: 'Mod-i', run: toggleWrap('*') },
          { key: 'Mod-`', run: toggleWrap('`') },
          ...searchKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) handleDocChanged()
          if (update.focusChanged) {
            if (update.view.hasFocus) handleFocus()
            else handleBlur()
          }
        }),
      ],
    })
    const editor = new EditorView({ state, parent: container.current })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [path, initialText, placeholder, autoHeight, compartments])

  useLayoutEffect(() => {
    view.current?.dispatch({ effects: compartments.live.reconfigure(live ? livePreview : []) })
  }, [live, compartments, path, initialText])

  useLayoutEffect(() => {
    view.current?.dispatch({ effects: compartments.focus.reconfigure(focusMode ? focusModeExtension : []) })
  }, [focusMode, compartments, path, initialText])

  return <div className="editor-host" ref={container} />
}
