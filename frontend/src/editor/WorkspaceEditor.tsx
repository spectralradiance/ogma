import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookType, Check, ChevronRight, Eye, FileText, Folder, FolderOpen, Save, Search, SquarePen } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import Markdown from 'react-markdown'

import { api } from '../api'
import type { WorkspaceFile, WorkspaceFileSummary } from '../types'
import { DictionaryInspector } from './DictionaryInspector'
import { MarkdownEditor } from './MarkdownEditor'


interface FileNode {
  name: string
  path: string
  children: FileNode[]
  file?: WorkspaceFileSummary
}

function buildTree(files: WorkspaceFileSummary[]): FileNode[] {
  const root: FileNode = { name: '', path: '', children: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let parent = root
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join('/')
      let node = parent.children.find((child) => child.name === name)
      if (!node) {
        node = { name, path, children: [] }
        parent.children.push(node)
      }
      if (index === parts.length - 1) node.file = file
      parent = node
    })
  }
  const sort = (nodes: FileNode[]): FileNode[] => nodes
    .sort((left, right) => {
      const folderDifference = Number(right.children.length > 0) - Number(left.children.length > 0)
      return folderDifference || left.name.localeCompare(right.name, undefined, { numeric: true })
    })
    .map((node) => ({ ...node, children: sort(node.children) }))
  return sort(root.children)
}

function filterTree(nodes: FileNode[], query: string): FileNode[] {
  if (!query) return nodes
  return nodes.flatMap((node) => {
    const children = filterTree(node.children, query)
    return node.path.toLowerCase().includes(query) || children.length
      ? [{ ...node, children }]
      : []
  })
}

export function WorkspaceEditor() {
  const [fileSearch, setFileSearch] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const files = useQuery({ queryKey: ['workspace-files'], queryFn: api.workspaceFiles })
  const document = useQuery({
    queryKey: ['workspace-file', selectedPath],
    queryFn: () => api.workspaceFile(selectedPath as string),
    enabled: Boolean(selectedPath),
  })
  const tree = useMemo(() => buildTree(files.data ?? []), [files.data])
  const visibleTree = useMemo(
    () => filterTree(tree, fileSearch.trim().toLowerCase()),
    [tree, fileSearch],
  )

  const chooseFile = (file: WorkspaceFileSummary) => {
    if (dirty && !window.confirm('Discard unsaved changes and open another file?')) return
    setDirty(false)
    setSelectedPath(file.path)
  }

  return <section className="editor-workspace">
    <aside className="editor-files">
      <div className="editor-pane-head"><div><p className="eyebrow">Local vault</p><h2>Source files</h2></div><span>{files.data?.length.toLocaleString() ?? '—'}</span></div>
      <label className="editor-file-search"><Search /><input value={fileSearch} onChange={(event) => setFileSearch(event.target.value)} placeholder="Find a file" /></label>
      <div className="editor-tree">
        {files.isLoading && <p className="editor-muted">Loading note catalog...</p>}
        {files.error && <p className="editor-error">{files.error.message}</p>}
        {visibleTree.map((node) => <FileTreeItem key={node.path} node={node} queryActive={Boolean(fileSearch)} selectedPath={selectedPath} onSelect={chooseFile} />)}
      </div>
    </aside>

    {document.data
      ? <DocumentSession key={document.data.path} document={document.data} onDirtyChange={setDirty} />
      : <Fragment>
        <div className="editor-document"><div className="editor-toolbar"><div className="editor-file-title"><p>{selectedPath?.split('/').at(-1) ?? 'No document selected'}</p><span>{selectedPath ?? 'Choose a Markdown or text file from the vault.'}</span></div></div><div className="editor-canvas">{!selectedPath && <div className="editor-placeholder"><FileText /><h2>Open a source note</h2><p>The editor preserves plain Markdown and saves directly to the selected local file.</p></div>}{selectedPath && document.isLoading && <div className="editor-placeholder">Loading document...</div>}{document.error && <div className="editor-placeholder editor-error">{document.error.message}</div>}</div></div>
        <aside className="editor-lexicon"><DictionaryInspector word={null} entries={undefined} loading={false} error={null} /></aside>
      </Fragment>}
  </section>
}

function DocumentSession({ document, onDirtyChange }: { document: WorkspaceFile; onDirtyChange: (dirty: boolean) => void }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(document.content)
  const [dirty, setDirty] = useState(false)
  const [mode, setMode] = useState<'write' | 'visual' | 'preview'>('write')
  const [selectedWord, setSelectedWord] = useState<string | null>(null)
  const dictionary = useQuery({ queryKey: ['dictionary-word', selectedWord], queryFn: () => api.defineWord(selectedWord as string), enabled: Boolean(selectedWord), retry: false })
  const save = useMutation({
    mutationFn: () => api.saveWorkspaceFile(document.path, draft),
    onSuccess: (saved) => {
      setDirty(false)
      onDirtyChange(false)
      queryClient.setQueryData(['workspace-file', document.path], saved)
      void queryClient.invalidateQueries({ queryKey: ['workspace-files'] })
    },
  })
  const updateDraft = (value: string) => {
    const changed = value !== document.content
    setDraft(value)
    setDirty(changed)
    onDirtyChange(changed)
  }
  return <>
    <div className="editor-document">
      <div className="editor-toolbar">
        <div className="editor-file-title"><p>{document.path.split('/').at(-1)}</p><span>{document.path}</span></div>
        <div className="editor-mode" role="group" aria-label="Document view"><button className={mode === 'write' ? 'selected' : ''} onClick={() => setMode('write')}><SquarePen />Write</button><button className={mode === 'visual' ? 'selected' : ''} onClick={() => setMode('visual')} title="Live formatted Markdown"><BookType />Live</button><button className={mode === 'preview' ? 'selected' : ''} onClick={() => setMode('preview')}><Eye />Preview</button></div>
        <button className="editor-save" disabled={!dirty || save.isPending} onClick={() => save.mutate()} title="Save (Ctrl+S)">{save.isSuccess && !dirty ? <Check /> : <Save />}{save.isPending ? 'Saving' : dirty ? 'Save' : 'Saved'}</button>
      </div>
      <div className="editor-canvas">{mode === 'write' && <MarkdownEditor initialDocument={draft} onChange={updateDraft} onSave={() => { if (dirty && !save.isPending) save.mutate() }} onSelectWord={setSelectedWord} />}{mode === 'visual' && <MarkdownEditor live initialDocument={draft} onChange={updateDraft} onSave={() => { if (dirty && !save.isPending) save.mutate() }} onSelectWord={setSelectedWord} />}{mode === 'preview' && <article className="markdown-preview"><Markdown>{draft}</Markdown></article>}</div>
      {save.error && <div className="editor-save-error">{save.error.message}</div>}
    </div>
    <aside className="editor-lexicon"><DictionaryInspector word={selectedWord} entries={dictionary.data} loading={dictionary.isLoading} error={dictionary.error?.message ?? null} /></aside>
  </>
}

function FileTreeItem({ node, queryActive, selectedPath, onSelect }: { node: FileNode; queryActive: boolean; selectedPath: string | null; onSelect: (file: WorkspaceFileSummary) => void }) {
  const folder = node.children.length > 0
  const [expanded, setExpanded] = useState(node.path === 'writing-desktop' || node.path === 'notion')
  const open = queryActive || expanded
  return <div className="editor-tree-node">
    <button className={node.file?.path === selectedPath ? 'selected' : ''} onClick={() => folder ? setExpanded(!expanded) : node.file && onSelect(node.file)} title={node.path}>
      {folder ? <><ChevronRight className={open ? 'expanded' : ''} />{open ? <FolderOpen /> : <Folder />}</> : <><span className="tree-spacer" /><FileText /></>}
      <span>{node.name}</span>
    </button>
    {open && folder && <div className="editor-tree-children">{node.children.map((child) => <FileTreeItem key={child.path} node={child} queryActive={queryActive} selectedPath={selectedPath} onSelect={onSelect} />)}</div>}
  </div>
}