# Ogma — Project Plan

Ogma is a desktop writing workspace with three parts: a Markdown editor that renders as you type (like Typora), documents that are one Markdown file each, split into sections by their `#` headings, with each section's **notes** kept inline beside its **output** (the text itself), and lexical and AI tools that work on the text you have selected.

---

## 1. What we can reuse

| Source | What it has | How Ogma uses it |
|---|---|---|
| **ogma/frontend** (React 19, TS, Vite, CodeMirror 6) | `editor/liveMarkdown.ts` (live render built on regexes, one line at a time), `MarkdownEditor.tsx`, `dictionaryHover.ts`, `DictionaryInspector.tsx`, `WorkspaceEditor.tsx` (file tree, Ctrl+S, atomic saves) | Starting point for the editor. We rebuild the live renderer on the Lezer syntax tree (see Phase 1). Hover and inspector patterns carry over. |
| **ogma/frontend/src/lib/dictionary** + `scripts/setup-wiktionary.ts` | Kaikki Wiktionary to SQLite with FTS5. `ogma/data/wiktionary.db` (~900 MB) is **already built** and stores senses, examples, IPA, **etymology, synonyms, antonyms, derived and related terms** | Copy the module as is. It covers the offline dictionary, etymology and most of the thesaurus with no network calls. |
| **ogma/code/write_book.py** + **ogma/api/jobs.py** | 4-bit Qwen loading with transformers and bitsandbytes, CUDA guardrails, a serialized GPU job queue with cancellation and SSE | The **local model provider** and job queue in the sidecar. |
| **aisling** (Electron, Vue 2) | Personal lexicon model `{word, definition, tags, synonyms}`, prefix search (`tag:`, `synonym:`), and a list of external lookup URLs (etymonline, rhymezone, M-W…) | Data model and UX ideas for the Lexicon, plus an importer for `Vocabulary/*.json`. The code is too old to reuse directly (Electron 1.7, Vue 2). |
| **oisin-old/pipeline** (Python) | Chunking, local embeddings (bge-small), taxonomy from folder structure, Claude synthesis prompts | Prompt and design reference for synthesis. Embeddings are used for related-notes search later. |
| **Existing notes trees** (e.g. `ogma/data/input/outlines_notes/`) | Already laid out as "folder = document, numbered file = section" (`1 universal narrative/1 the first era`), and many files are extensionless or `.txt` | Added to the workspace **as they are** and edited in place (§3). They are the main test material. |

---

## 2. Architecture

```
Renderer (React + TS + Vite)
 ├─ Sidebar: workspace roots → folders → documents; Outline: the open document's sections
 ├─ Editor: one CodeMirror 6 instance per document, showing Output / Notes / Both
 └─ Right drawer: Dictionary / Etymology / Thesaurus / Lexicon / AI
        ▲  typed IPC (contextBridge)
Electron main process (Node)
 ├─ Workspace service   — multiple root folders, section discovery, file watching, in-place atomic saves
 ├─ Dictionary service  — better-sqlite3 over wiktionary.db (reused from ogma)
 ├─ Lexicon service     — saved words
 ├─ Secrets             — API keys in the OS keychain (safeStorage), passed to the sidecar at launch
 └─ Sidecar manager     — starts and stops the Python process, checks its health, restarts it if it crashes
        ▲  HTTP + SSE on 127.0.0.1:<random port>, per-session bearer token
Python AI sidecar (FastAPI + uvicorn, own venv)
 ├─ Router              — picks a model profile for each task, with fallback (§2a)
 ├─ Provider layer      — one interface; the rest of the app never imports a vendor SDK
 │   ├─ local_hf        — transformers + bitsandbytes on CUDA (4-bit Qwen), the ogma approach
 │   ├─ anthropic       — Claude
 │   ├─ openai          — ChatGPT / OpenAI models
 │   ├─ gemini          — Google Gemini (google-genai SDK)
 │   └─ openai_compat   — any OpenAI-compatible endpoint (base URL + key): OpenRouter,
 │                        privacy-focused open-model hosts, or a local server later
 ├─ Embeddings          — sentence-transformers (bge-small) for related-notes search
 ├─ GPU job queue       — one GPU job at a time, cancellable, streamed over SSE (from ogma)
 └─ Prompt templates    — editable Markdown files, independent of the provider (§3)
```

**Why Electron with a Python sidecar:**
- The app edits folders on disk in place, so it needs real filesystem access and file watching. Electron provides both.
- `better-sqlite3` and the existing dictionary code run in Node without changes.
- Ogma's React and CodeMirror code moves straight into the renderer.
- CUDA, quantization and embeddings belong in Python, where ogma already has working code.
- The editor never depends on the sidecar. Editing, dictionary and lexicon work even when Python isn't running, and only the AI panel shows "offline".
- All AI calls go through the sidecar, whichever provider serves them. That puts prompts, routing and history logging in one place, and the renderer uses a single streaming interface.

**Why CodeMirror 6 and not ProseMirror, Milkdown or TipTap:**
- The file on disk stays the source of truth, with no round-trip formatting loss. This matters more now that we edit your original files in place.
- The hover and lexical extensions already exist for it.
- Typora-style rendering is done with decorations that hide Markdown syntax except where the cursor is.

### 2a. Provider abstraction

Features never call a vendor directly. They call `run(task, messages)`, and the router resolves the task to a **model profile** and then to a provider adapter.

```python
class Provider(Protocol):
    id: str                                   # "anthropic", "openai", "gemini", "openai_compat", "local_hf"
    def models(self) -> list[ModelInfo]: ...  # id, context window, cost hints, capabilities
    def health(self) -> ProviderHealth: ...   # key present, reachable, CUDA ok, …
    def stream(self, req: GenerateRequest) -> Iterator[StreamEvent]: ...
```

- **One request shape:** `GenerateRequest` holds the system prompt, messages, max tokens, temperature and stop sequences. Each adapter translates it to its vendor's format. For example, Claude takes the system prompt as a separate field, OpenAI takes it as a message with the `system` role, and Gemini takes it as `system_instruction`.
- **One event shape:** every stream produces `text_delta`, `usage` (input and output tokens), `done` (stop reason) and `error`.
- **One error set:** vendor errors map to `auth`, `rate_limit`, `context_too_long`, `unavailable` and `bad_request`. The router uses these to decide whether to fall back, so features never see vendor-specific errors.
- **Adapters use the official SDKs**: `anthropic`, `openai` and `google-genai`, plus the `openai` SDK pointed at a custom `base_url` for `openai_compat`. The alternative is LiteLLM, which covers more vendors with one dependency but is a thick, fast-moving layer. The interface above keeps it possible to switch to LiteLLM later without touching features.
- **`openai_compat`** is how privacy-focused hosted open models plug in: OpenRouter, Together, Fireworks, or any host with an OpenAI-style API. A local LM Studio or Ollama server could be added later the same way, with no new code.
- **Model profiles** live in settings. A profile is a named `{provider, model, params}`, for example:
  ```json
  "profiles": {
    "claude-main":   { "provider": "anthropic", "model": "claude-sonnet-5", "max_tokens": 4096 },
    "gpt-alt":       { "provider": "openai",    "model": "<model id>" },
    "gemini-alt":    { "provider": "gemini",    "model": "<model id>" },
    "open-private":  { "provider": "openai_compat", "base_url": "https://…", "model": "<open model>" },
    "qwen-local":    { "provider": "local_hf",  "model": "Qwen/Qwen2.5-7B-Instruct", "quant": "4bit" }
  },
  "routing": {
    "synthesize": ["claude-main", "gemini-alt", "qwen-local"],
    "analyze":    ["qwen-local", "claude-main"],
    "lexical":    ["qwen-local", "claude-main"]
  }
  ```
- **Modes:** *Local* only allows `local_hf` profiles. *Cloud* only allows remote profiles. *Hybrid* (the default) follows the routing table. The AI panel can override the profile for a single request, and it shows when a fallback was used.
- **Keys:** each provider's API key is stored in the OS keychain (safeStorage) and passed to the sidecar as an environment variable at launch. Keys are never written to settings files.
- **Provenance:** every run records the profile, provider, model, token usage and a hash of the input.
- **Contract tests:** one shared test suite runs against every adapter, using recorded fixtures offline, plus an optional live smoke test when a key is set.

---

## 3. Workspace and on-disk format

**A workspace is a set of external folders edited in place. Nothing is copied.**

```
Workspace file  (e.g. Documents/Ogma/writing.ogma-workspace — like a VS Code .code-workspace)
{
  "roots": [
    "C:/Users/snowb/Programs/text editors/ogma/data/input/outlines_notes",
    "D:/writing/poetry"
  ],
  "lexicon": "C:/Users/snowb/Documents/Ogma/lexicon",
  "promptsDir": "C:/Users/snowb/Documents/Ogma/prompts"
}
```

**Documents** (changed 2026-10-11; the earlier folder-of-sections format, with a `-notes` and an `-output` file per section, was removed):
- A **document is one Markdown file**. Folders are just folders, shown in the sidebar with their subfolders and documents.
- Text files are `.md`, `.markdown`, `.txt`, `.text`, and files with no extension, the same rules as ogma's indexer.
- Each `#` heading starts a **section**; `##` and deeper stay inside it. A file with no `#` heading splits at its shallowest heading level. Sections are reordered, merged and renamed by editing the text.
- A section's **notes** sit in Pandoc-style fenced blocks, `::: notes` … `:::`, usually under its text. Notes before the first heading are notes for the whole document (outline, sources). Headings inside notes never start a section.
- One editor shows the file as **Output** (the text, notes hidden), **Notes** (all notes as one flow under the section headings) or **Both**.

**Editing in place safely:**
- Atomic saves: write to a temp file in the same folder, then rename.
- **Preserve encoding and line endings.** Old `.txt` notes may be cp1252 or UTF-8 with a BOM, and may use CRLF. The file is detected on open and written back in the same format.
- The file watcher detects edits made outside Ogma (VS Code, sync tools). A clean buffer reloads silently. A buffer with unsaved changes shows a merge or keep-mine prompt.
- **Backup on first write:** the first time a file is modified in a session, its original is copied to `<appData>/Ogma/backups/<date>/…`. Backups are pruned after N days.
- Delete moves files to the OS trash, never deletes them permanently.

**App-owned data stays out of your folders by default.** It lives in `<appData>/Ogma/`:
- Per-document metadata (manual order overrides, collapsed state, custom section titles), keyed by path.
- AI run history.
- A "store metadata in folder" option per root writes an `.ogma/` folder into that root instead, for roots you sync between machines.

The lexicon and prompt templates live in the folders named in the workspace file, as Markdown files with front-matter, so they can be read and edited outside the app.

---

## 3a. Repository layout (this `ogma/` folder)

```
ogma/
  app/                  # Electron + React + TS (electron-vite)
    src/main/           # workspace, dictionary, lexicon, sidecar manager, IPC
    src/preload/
    src/renderer/       # React UI, CodeMirror extensions
  sidecar/              # Python FastAPI AI server
    ogma_ai/
      main.py           # routes: /health, /providers, /ai/run (SSE), /jobs, /embed
      router.py         # task → profile → provider, mode filtering, fallback
      types.py          # GenerateRequest, StreamEvent, ProviderError kinds
      providers/        # base.py, local_hf.py, anthropic.py, openai.py, gemini.py, openai_compat.py
      jobs.py           # GPU queue (from ogma)
    tests/
    requirements.txt
  scripts/              # dev.ps1 (launch both), setup-sidecar.ps1 (venv + CUDA torch)
  PLAN.md
```

---

## 4. Build phases

### Phase 0 — Scaffold (1 day) ✅ done 2026-09-25
- `app/`: electron-vite with React and TS, ESLint and Vitest. Typed IPC bridge.
- `sidecar/`: FastAPI skeleton with `/health` reporting CUDA availability, VRAM, loaded models, and which provider keys are configured. Pytest.
- The sidecar manager spawns the venv Python on a free port with a random token, waits for `/health`, and kills the process tree on quit.
- `scripts/dev.ps1` runs both pieces for development.
- **Done when:** the app launches and the status bar shows the sidecar and GPU status.

### Phase 1 — Live Markdown editor (the core, ~1 week) ✅ done 2026-09-25
Also landed early from Phase 2 because in-place editing needed them: a lazy file tree per root, atomic saves, conflict detection (mtime), and backup-on-first-write. The folder watcher and section model remain Phase 2.

- Port `MarkdownEditor.tsx` and rewrite `liveMarkdown.ts` to walk the **Lezer syntax tree** instead of using regexes:
  - Headings, bold, italic, strike, inline code, links (show the text and hide the URL), images (render inline), blockquotes, lists and task checkboxes, horizontal rules, fenced code (with highlighting), tables (render as a widget, show the source when the cursor is inside).
  - Syntax is revealed only for the **node** under the cursor, not the whole line, which is how Typora behaves.
- `.txt` and extensionless files open in the same editor. Markdown rendering applies wherever the text happens to be Markdown.
- Typography theme (serif body, comfortable line length), light and dark modes, focus mode.
- Ctrl+S, autosave with a debounce, an unsaved-changes indicator, and encoding and line-ending preservation.
- **Done when:** any file from your notes opens, edits and saves back byte-identical except for your changes, and looks rendered everywhere except where the cursor is.

### Phase 2 — Workspace, documents & sections (~1 week) ✅ done 2026-09-25
What shipped differs from the spec below in four places:
- Roots live in the app's settings; the separate `.ogma-workspace` file (several named workspaces) is deferred until it is needed.
- Reordering is ↑/↓ (swapping ordinals, both files renamed together) rather than drag and drop.
- Scroll sync between panes is deferred.
- The watcher uses Node's recursive `fs.watch`; on folders it cannot watch (possibly some cloud-drive mounts) the tree only refreshes when a folder is reopened, but edits still never overwrite outside changes, because every save checks the file's mtime.

- Workspace file: create or open it, and add or remove roots (folder picker). The last workspace reopens on launch.
- Section discovery as in §3, with a watcher on every root. Create, rename, reorder and delete sections. Renaming renames the notes and output files together. Reordering changes the number prefix, or only the metadata if you prefer that.
- Sidebar: roots → documents (nested) → a Document notes group + ordered sections, plus headings inside each file as sub-entries.
- **Dual pane:** notes on the left and output on the right, with a resizable splitter. Each pane can collapse, and the two panes can switch places. Optional scroll sync matched by heading.
- Backups on first write, and external-change handling.
- **Done when:** you add `outlines_notes` as a root and work through `universal metaphysics` section by section, with your original files edited in place.

### Phase 2b — Whole-document views ✅ done 2026-09-25
A double document (folder of sections) opens whole, in four views: **Column** (each section's output, then its notes as a background block), **Side by side** (aligned rows), **Output** only and **Notes** only. Single files open as regular documents.

### Phase 2c — One file per document ✅ done 2026-10-11
Replaced the folder-of-sections format (Phases 2 and 2b) with the one-file format in §3: sections from `#` headings, inline notes blocks, and Output / Notes / Both views of one editor. The section files, section operations (rename, move, merge, delete) and the per-section view are gone; the sidebar lists plain folders and documents, with rename and undoable delete for files. Stats, export, search and AI drafting work on the single file.

### Phase 3 — Lexical tools (~1 week, mostly reuse) ✅ done 2026-09-25
Uses Node's built-in `node:sqlite` (no native module) over ogma's `wiktionary.db`, with indexed case-variant lookups (the original `COLLATE NOCASE` query scanned all 1.5M rows, ~10 s). Not done: underlining lexicon words in the text.

- Copy ogma's dictionary module and point it at `wiktionary.db`. The path is configurable, and the setup script can rebuild the database if it is missing.
- Right-hand drawer with tabs that follow the current selection or the word under the cursor:
  - **Define:** senses, examples, IPA and part of speech.
  - **Etymology:** the etymology text, with root words you can click to look up.
  - **Thesaurus:** synonyms, antonyms, related and derived terms. Clicking a term looks it up, and Alt+click replaces your selection with it.
  - **External:** Aisling's lookup-URL table (etymonline, rhymezone, M-W) opened in a panel or the browser.
- Hover definition (from ogma's `dictionaryHover.ts`) and a Ctrl+D shortcut to open the drawer.
- **Lexicon:** a "Save word" action stores the word, definition, tags, your own note, and the sentence and section it came from. There is a lexicon browser with Aisling-style prefix search (`tag:`, `syn:`), and an importer for Aisling's `Vocabulary/*.json`.
- Optional: underline words in the text that are already in your lexicon.

### Phase 4 — AI tools (~2 weeks) ✅ done 2026-09-25
Tested end to end against a local mock of an OpenAI-compatible server (no API keys were available); the Claude, OpenAI and Gemini adapters are contract-tested through their real SDKs against mocks of each wire format. Not yet exercised: live cloud calls and the local GPU model (needs `setup-sidecar.ps1` without `-NoTorch` and a model download). Draft output uses the section's notes, current output and document notes; neighbouring sections are not yet included.
- **4a. Provider layer (sidecar):**
  - The `Provider` protocol, the shared request and event types, and error normalization (§2a).
  - `local_hf` ported from ogma: 4-bit Qwen that loads lazily, frees VRAM after an idle timeout, and keeps the CUDA guardrails.
  - `anthropic` first. Then `openai`, `gemini` and `openai_compat`, each about a day, since they only translate to and from the shared types.
  - A router with profiles, the routing table, mode filtering and fallback on `unavailable`, `rate_limit` or `auth`. SSE streaming to the app.
  - A contract test suite run against every adapter, plus a fake provider for feature tests.
- **4b. AI panel and settings (app):**
  - A mode switch (Local / Cloud / Hybrid) and a per-request profile picker.
  - A streaming output view with cancel, and a provenance note on each result.
  - A settings page for API keys (keychain), model profiles and the routing table, with a "test connection" button for each provider.
- **Analyze** (current selection or section): tone, structure, readability (the numeric scores such as Flesch and sentence-length spread are computed locally, and the AI adds the qualitative read), and style notes. Results appear in the drawer, not in your text.
- **Synthesize notes → output:** reads the notes file (plus, optionally, the document notes such as `outline`, the output of the neighbouring sections, and a style guide) and puts a draft into a **diff/merge view** against the output file. You accept or reject each hunk, so the AI never overwrites your text silently.
- **Lexical assist:** "vary this word", "stronger verb", and "thematic vocabulary for this section". Suggestions come back as a list, and each option is checked against the local dictionary.
- Prompt templates are editable `.md` files (the same idea as ogma's `guidance.json`), and each run is logged to the history.

### Phase 5 — Polish & later ✅ done 2026-09-25 (except embeddings)
Shipped: search across all roots (SQLite FTS5 index, Ctrl+Shift+F), keyword-based "related notes", export to PDF/HTML/Markdown, per-file version history (automatic every 10 minutes while editing, plus labelled snapshots, diff and restore), and writing statistics (per-section counts, output goal, net words per day). Not done: DOCX export, embedding-based related notes (needs the PyTorch stack), git-backed history.
- Global search across all roots (ripgrep or SQLite FTS).
- Export a whole document as the output files joined into one `.md`, HTML, PDF or DOCX.
- Version snapshots for each section (git per root, or the backup store).
- "Related notes" for the current section using embeddings across all roots (oisin-old / ogma retrieval).
- Word-count goals and writing statistics for each section.

**Deferred (not planned for now):**
- LM Studio / Bionic integration. Its models could be used through `openai_compat` with no new code. An Ogma MCP server that lets Bionic or Claude work on the workspace (with edits as reviewable proposals) could be revisited later.

---

## 5. Decisions

**Decided:**
- Electron plus a Python AI sidecar.
- AI runs through a provider abstraction: a local model (ogma-style transformers/bitsandbytes), plus Claude, OpenAI, Gemini and any OpenAI-compatible host. The modes are Local, Cloud and Hybrid.
- LM Studio / Bionic is deferred.
- A workspace is a set of external folders edited in place, with no copying.
- The code lives in this `ogma/` folder. The scope is the features listed here and nothing more.

- A document is one Markdown file: `#` headings make the sections and notes are inline (§3). This settles the earlier open questions about reordering sections and naming output files.
