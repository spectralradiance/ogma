import { useMemo, useState } from 'react'
import { ChevronRight, FileText, Folder, FolderOpen, Search } from 'lucide-react'
import type { AnalysisResult } from './types'

type Document = AnalysisResult['documents'][number]
type BrowseTab = 'documents' | 'topics' | 'keywords'
const exportMetadataTerm = /(?:^|\s)(?:zim|wiki format|text zim wiki)(?:\s|$)/i

interface TreeNode {
  name: string
  path: string
  children: TreeNode[]
  document?: Document
}

function topicName(name: string, displayName?: string) {
  if (displayName) return displayName
  const generic = new Set(['self', 'thing', 'things', 'world', 'write', 'writing'])
  const seen = new Set<string>()
  return name.replace(/^\d+_/, '').split('_').filter((word) => {
    const key = word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word
    if (generic.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 3).map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' / ')
}

function legacyLevel(path: string) {
  const match = path.match(/(?:^|\/)chaos\/(\d{3}-\d{3})\/(\d{1,3})(?:\D|\/)/)
  return match ? { range: match[1], level: Number(match[2]) } : null
}

function buildTree(documents: Document[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] }
  for (const document of documents) {
    const parts = document.path.split('/').filter(Boolean)
    let parent = root
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/')
      let node = parent.children.find((child) => child.name === part)
      if (!node) {
        node = { name: part, path, children: [] }
        parent.children.push(node)
      }
      if (index === parts.length - 1) node.document = document
      parent = node
    })
  }
  const sort = (nodes: TreeNode[]): TreeNode[] => nodes
    .sort((left, right) => {
      const leftFolder = left.children.length > 0
      const rightFolder = right.children.length > 0
      return leftFolder === rightFolder
        ? left.name.localeCompare(right.name, undefined, { numeric: true })
        : leftFolder ? -1 : 1
    })
    .map((node) => ({ ...node, children: sort(node.children) }))
  return sort(root.children)
}

function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  if (!query) return nodes
  return nodes.flatMap((node) => {
    const children = filterTree(node.children, query)
    const matches = node.name.toLowerCase().includes(query) || node.path.toLowerCase().includes(query)
    return matches || children.length ? [{ ...node, children }] : []
  })
}

export function CorpusBrowser({ result }: { result: AnalysisResult }) {
  const [tab, setTab] = useState<BrowseTab>('documents')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Document | null>(null)
  const tree = useMemo(() => buildTree(result.documents), [result.documents])
  const visibleTree = useMemo(() => filterTree(tree, query.trim().toLowerCase()), [tree, query])
  const topics = useMemo(() => result.topics
    .filter((topic) => topic.Topic >= 0)
    .filter((topic) => `${topicName(topic.Name, topic.DisplayName)} ${(topic.Representation ?? []).join(' ')}`.toLowerCase().includes(query.toLowerCase())), [result.topics, query])
  const keywordDocumentCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const document of result.documents) {
      for (const keyword of new Set(document.keywords ?? [])) {
        counts.set(keyword, (counts.get(keyword) ?? 0) + 1)
      }
    }
    return counts
  }, [result.documents])
  const keywords = result.keywords.filter((keyword) => !exportMetadataTerm.test(keyword.term) && keyword.term.toLowerCase().includes(query.toLowerCase()))
  const topicLabels = useMemo(() => new Map(
    result.topics.map((topic) => [topic.Topic, topicName(topic.Name, topic.DisplayName)]),
  ), [result.topics])

  return <section className="panel corpus-browser">
    <div className="browser-head">
      <div><p className="eyebrow">Analyzed corpus</p><h2>Browse sources</h2></div>
      <div className="browser-tabs" role="tablist">
        {(['documents', 'topics', 'keywords'] as BrowseTab[]).map((item) => <button key={item} className={tab === item ? 'selected' : ''} onClick={() => { setTab(item); setQuery('') }}>{item}</button>)}
      </div>
      <label className="browser-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${tab}`} /></label>
    </div>

    {tab === 'documents' && <div className="document-browser">
      <div className="tree-panel">{visibleTree.length ? visibleTree.map((node) => <TreeItem key={node.path} node={node} queryActive={Boolean(query)} selectedPath={selected?.path} onSelect={setSelected} />) : <p className="browser-empty">No matching files or folders.</p>}</div>
      <DocumentInspector document={selected} topicLabel={selected ? topicLabels.get(selected.topic) : undefined} />
    </div>}

    {tab === 'topics' && <div className="catalog-grid">{topics.map((topic) => <article key={topic.Topic}><span className="catalog-count">{topic.Count} documents</span><h3>{topicName(topic.Name, topic.DisplayName)}</h3><p>{(topic.Representation ?? []).slice(0, 8).join(' · ')}</p></article>)}</div>}

    {tab === 'keywords' && <div className="catalog-grid keyword-catalog">{keywords.map((keyword) => <article key={keyword.term}><span className="catalog-count">{keywordDocumentCounts.get(keyword.term) ?? 0} documents</span><h3>{keyword.term}</h3><p>Relevance score {keyword.score.toFixed(3)}</p></article>)}</div>}
  </section>
}

function TreeItem({ node, queryActive, selectedPath, onSelect }: { node: TreeNode; queryActive: boolean; selectedPath?: string; onSelect: (document: Document) => void }) {
  const isFolder = node.children.length > 0
  const [expanded, setExpanded] = useState(false)
  const open = queryActive || expanded
  return <div className="tree-node">
    <button className={selectedPath === node.document?.path ? 'selected' : ''} onClick={() => isFolder ? setExpanded(!expanded) : node.document && onSelect(node.document)} title={node.path}>
      {isFolder ? <><ChevronRight className={open ? 'expanded' : ''} />{open ? <FolderOpen /> : <Folder />}</> : <><span className="tree-spacer" /><FileText /></>}
      <span>{node.name}</span>
    </button>
    {open && node.children.length > 0 && <div className="tree-children">{node.children.map((child) => <TreeItem key={child.path} node={child} queryActive={queryActive} selectedPath={selectedPath} onSelect={onSelect} />)}</div>}
  </div>
}

function DocumentInspector({ document, topicLabel }: { document: Document | null; topicLabel?: string }) {
  if (!document) return <div className="document-inspector empty-inspector"><FileText /><h3>Select a document</h3><p>Choose a file to inspect its modeled topic, hierarchy, and extracted keywords.</p></div>
  const inferredLevel = legacyLevel(document.path)
  const level = document.level ?? inferredLevel?.level
  const levelRange = document.level_range ?? inferredLevel?.range
  return <div className="document-inspector">
    <p className="eyebrow">Document</p>
    <h3>{document.path.split('/').at(-1)}</h3>
    <code>{document.path}</code>
    <dl>
      <div><dt>Topic</dt><dd>{topicLabel ?? document.topic_name}</dd></div>
      <div><dt>Directory depth</dt><dd>{document.depth}</dd></div>
      <div><dt>Numbered level</dt><dd>{level != null ? `${level} (${levelRange})` : 'Outside chaos levels'}</dd></div>
      <div><dt>Analyzed text</dt><dd>{document.character_count?.toLocaleString() ?? 'Legacy result'} characters</dd></div>
    </dl>
    <h4>Keywords</h4>
    <div className="document-keywords">{document.keywords?.length ? document.keywords.map((keyword) => <span key={keyword}>{keyword}</span>) : <small>Run a new analysis for per-document keywords.</small>}</div>
    <h4>Excerpt</h4>
    <p className="document-excerpt">{document.excerpt ?? 'Run a new analysis to include a cleaned document excerpt.'}</p>
  </div>
}
