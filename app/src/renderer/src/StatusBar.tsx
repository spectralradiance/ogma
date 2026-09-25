import { encodingLabel, lineEndingLabel } from '../../shared/text'
import type { DocumentInfo } from './DocumentPane'

interface StatusBarProps {
  documentInfo: DocumentInfo | null
  /** Which pane the document info describes, e.g. "Notes". */
  documentLabel?: string
  /** Net words written today across all files. */
  todayWords?: number | null
}

export function StatusBar({ documentInfo, documentLabel, todayWords }: StatusBarProps) {
  return (
    <footer className="statusbar">
      {todayWords !== undefined && todayWords !== null && todayWords !== 0 && (
        <span className="status-item status-today" title="Net words written today, all files">
          Today {todayWords > 0 ? '+' : ''}{todayWords.toLocaleString()}
        </span>
      )}
      {documentInfo && (
        <span className="status-document">
          {documentLabel && <span className="status-pane">{documentLabel}</span>}
          <span>{documentInfo.words.toLocaleString()} {documentInfo.words === 1 ? 'word' : 'words'}</span>
          <span title="File encoding">{encodingLabel(documentInfo.format.encoding)}</span>
          <span title="Line endings">
            {lineEndingLabel(documentInfo.format.eol)}{documentInfo.format.mixedEol ? ' (mixed)' : ''}
          </span>
        </span>
      )}
    </footer>
  )
}
