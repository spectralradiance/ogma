import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { drawSelection, dropCursor, EditorView, keymap, placeholder as placeholderText } from '@codemirror/view'
import { type Ref, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'

import { isSingleWord, matchCase, sentenceAround, wordAt } from '../../../shared/text'
import { toggleWrap } from './commands'
import { dictionaryHover } from './dictionaryHover'
import { focusMode as focusModeExtension } from './focusMode'
import { documentPath, livePreview } from './livePreview'
import { addOrJumpToNotes, notesBlocks, notesView as notesViewFacet, type NotesView, revealSelection, SHOW_NOTES_EVENT } from './notesBlocks'
import { autoHeightTheme, editorTheme } from './theme'

export interface MarkdownEditorHandle {
  getText(): string
  focus(): void
  /** Puts the cursor at the start of a 1-based line and scrolls it to the top. */
  revealLine(line: number): void
  /** The selected word, or the word at the cursor, with the sentence it sits in. */
  currentWord(): WordInContext | null
  /** Replaces the selection, or the word at the cursor, matching its capitalization. */
  replaceWord(replacement: string): boolean
  getSelection(): string
  /** Replaces the whole document as one undoable change (only the part that differs is touched). */
  replaceAll(text: string): void
  /** The 1-based line the cursor is on. */
  cursorLine(): number
}

export interface WordInContext {
  word: string
  context: string
}

function wordInContext(state: EditorState): (WordInContext & { from: number; to: number }) | null {
  const selection = state.selection.main
  const line = state.doc.lineAt(selection.head)
  if (!selection.empty) {
    const text = state.sliceDoc(selection.from, selection.to).trim()
    if (!isSingleWord(text) || state.doc.lineAt(selection.from).number !== line.number) return null
    return { word: text, context: sentenceAround(line.text, selection.from - line.from, selection.to - line.from), from: selection.from, to: selection.to }
  }
  const match = wordAt(line.text, selection.head - line.from)
  if (!match) return null
  return { word: match.word, context: sentenceAround(line.text, match.from, match.to), from: line.from + match.from, to: line.from + match.to }
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
  /** Show the text alone, the notes alone, or both (see notesBlocks). */
  notesView?: NotesView
  /** A command needs the notes view (Ctrl+Alt+N in the output view). */
  onShowNotes?: () => void
  onDocChanged: () => void
  onSave: () => void
  onBlur: () => void
  onFocus?: () => void
  /** A single word was selected (for following lookups in the lexical panel). */
  onSelectWord?: (word: WordInContext) => void
}

const noop = () => {}

/**
 * Uncontrolled CodeMirror editor. The parent reads the text through the handle
 * instead of receiving it on every keystroke, which keeps large notes fast.
 */
export function MarkdownEditor({
  ref, path, initialText, placeholder, autoHeight = false, live, focusMode, notesView = 'all', onShowNotes, onDocChanged, onSave, onBlur, onFocus, onSelectWord,
}: MarkdownEditorProps) {
  const container = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [compartments] = useState(() => ({ live: new Compartment(), focus: new Compartment(), notes: new Compartment() }))
  const handleDocChanged = useEffectEvent(onDocChanged)
  const handleSave = useEffectEvent(onSave)
  const handleBlur = useEffectEvent(onBlur)
  const handleFocus = useEffectEvent(onFocus ?? noop)
  const handleSelectWord = useEffectEvent((word: WordInContext) => onSelectWord?.(word))
  const handleShowNotes = useEffectEvent(onShowNotes ?? noop)

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
    currentWord: () => {
      const editor = view.current
      if (!editor) return null
      const found = wordInContext(editor.state)
      return found ? { word: found.word, context: found.context } : null
    },
    replaceWord: (replacement) => {
      const editor = view.current
      const found = editor ? wordInContext(editor.state) : null
      if (!editor || !found) return false
      const insert = matchCase(found.word, replacement)
      editor.dispatch({
        changes: { from: found.from, to: found.to, insert },
        selection: EditorSelection.range(found.from, found.from + insert.length),
        userEvent: 'input.replace',
      })
      editor.focus()
      return true
    },
    getSelection: () => {
      const editor = view.current
      if (!editor) return ''
      return editor.state.selection.ranges.map((range) => editor.state.sliceDoc(range.from, range.to)).join('\n')
    },
    replaceAll: (text) => {
      const editor = view.current
      if (!editor) return
      const current = editor.state.doc.toString()
      let start = 0
      while (start < current.length && start < text.length && current[start] === text[start]) start += 1
      let end = 0
      while (end < current.length - start && end < text.length - start
        && current[current.length - 1 - end] === text[text.length - 1 - end]) end += 1
      editor.dispatch({
        changes: { from: start, to: current.length - end, insert: text.slice(start, text.length - end) },
        userEvent: 'input.replace',
        scrollIntoView: true,
      })
    },
    cursorLine: () => {
      const editor = view.current
      return editor ? editor.state.doc.lineAt(editor.state.selection.main.head).number : 1
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
        compartments.notes.of([]),
        notesBlocks,
        editorTheme,
        autoHeight ? autoHeightTheme : ([] as Extension),
        EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'off', autocapitalize: 'off' }),
        placeholder ? placeholderText(placeholder) : [],
        dictionaryHover,
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { handleSave(); return true } },
          { key: 'Mod-b', run: toggleWrap('**') },
          { key: 'Mod-i', run: toggleWrap('*') },
          { key: 'Mod-`', run: toggleWrap('`') },
          { key: 'Mod-Alt-n', run: addOrJumpToNotes },
          ...searchKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) handleDocChanged()
          if (update.selectionSet && !update.state.selection.main.empty) {
            const found = wordInContext(update.state)
            if (found) handleSelectWord({ word: found.word, context: found.context })
          }
          if (update.focusChanged) {
            if (update.view.hasFocus) handleFocus()
            else handleBlur()
          }
        }),
      ],
    })
    const editor = new EditorView({ state, parent: container.current })
    view.current = editor
    const showNotes = () => handleShowNotes()
    editor.dom.addEventListener(SHOW_NOTES_EVENT, showNotes)
    return () => {
      editor.dom.removeEventListener(SHOW_NOTES_EVENT, showNotes)
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

  useLayoutEffect(() => {
    const editor = view.current
    if (!editor) return
    editor.dispatch({ effects: compartments.notes.reconfigure(notesViewFacet.of(notesView)) })
    revealSelection(editor)
  }, [notesView, compartments, path, initialText])

  return <div className="editor-host" ref={container} />
}
