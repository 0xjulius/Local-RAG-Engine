# Architecture & Decision Log

## Data flow
Upload PDF to a conversation -> API (202 Accepted) -> background ingestion -> chunk -> embed (LM Studio) + sparse BM25 (fastembed) -> Qdrant

Query (with `conversation_id`) -> hybrid retrieval restricted to that conversation's documents (Qdrant payload filter on `conversation_id`) -> numbered-context prompt -> LM Studio -> SSE stream (sources first, then tokens, then `done`)

The question, the streamed answer and its sources are also saved in the conversation history. Every query is written to an in-memory search log together with the retrieved sources and the streamed answer, so any past question can be reopened from the admin view.

## Components
- **Qdrant** (Docker): vector + sparse index
- **Backend** (Docker, FastAPI + LlamaIndex): conversations, ingestion, retrieval, streaming, search log
- **State file** (`state.json` on the uploads volume): documents and conversations (including messages), so history survives restarts
- **Frontend** (Docker, React + Vite + Tailwind, served by nginx): chat, document management, admin log viewer
- **LM Studio** (host): OpenAI-compatible inference server for both chat and embedding models

## API
| Endpoint | Purpose |
|---|---|
| `POST /api/conversations` | Create an empty conversation |
| `GET /api/conversations` | List conversations (title, last activity, message count, document names), newest first |
| `GET /api/conversations/{id}` | One conversation with its messages and documents |
| `DELETE /api/conversations/{id}` | Delete the conversation, its documents, files and vectors |
| `POST /api/conversations/{id}/documents` | Upload a PDF to a conversation (returns 202, ingestion runs in the background) |
| `GET /api/conversations/{id}/documents` | Documents of one conversation and their status (`queued`, `processing`, `ready`, `failed`) |
| `GET /api/documents` | All documents (diagnostics) |
| `DELETE /api/documents/{doc_id}` | Delete one document: file, vectors and state entry |
| `POST /api/query` | Hybrid retrieval over the conversation's documents + streamed answer (SSE: `sources`, `token`, `done`, `error`) |
| `GET /api/admin/search-logs` | Last 100 queries (lightweight: scores and timings, no answer text) |
| `GET /api/admin/search-logs/{id}` | Full entry: question, answer, sources, timings, error |
| `GET /api/health` | Model names, LLM base URL, document count |

## Conversations and documents
- A conversation owns its documents: a PDF is uploaded into one conversation and is only searched there. Other conversations never see it.
- Ingestion tags every chunk with `conversation_id`; queries filter on it, so retrieval cannot leak across conversations.
- Conversations are created lazily by the first upload or question, so the history has no empty entries. The title is taken from the first question.
- The history list in the sidebar shows title, document names, last activity and question count. Opening an entry restores its messages (with sources) and documents.
- Deleting a conversation removes its documents, files and vectors. Deleting a document removes only that document.
- Suggested questions ("Kokeile:") are generated per document and shown only for the open conversation.

## Frontend behaviour
- **Markdown rendering:** answers are rendered with `react-markdown` + `remark-gfm` (headings, lists, bold, tables) and styled with `@tailwindcss/typography`. Tables are wrapped in a horizontally scrollable container.
- **Streaming:** the SSE stream is parsed incrementally; sources arrive first and are shown with the answer when it completes.
- **Admin log:** rows are clickable. A detail dialog shows the question, the rendered answer and the retrieved sources with scores. "Avaa keskustelu" opens the conversation the query belonged to.
- **Dev proxy:** Vite proxies `/api` to `localhost:8000`. In Docker, nginx proxies `/api/` to the backend with buffering disabled for SSE.

## Decisions
| Decision | Why | Trade-off |
|---|---|---|
| OpenAI-compatible LLM client | Swap LM Studio / vLLM / cloud via `.env` only | Provider-specific features unavailable |
| Qdrant | Native hybrid search, payload filtering | One more service than Chroma |
| LM Studio on host | GUI to tune context, GPU offload, quantization; shows tokens/sec | Not in Compose, so not fully reproducible; use vLLM/llama.cpp server for real deployments |
| Multilingual embeddings (e.g. bge-m3) | Finnish/English/Swedish documents | Larger than English-only models |
| BackgroundTasks | Zero extra infra for demo | Lost on restart; use Celery + Redis for production |
| SSE streaming | Perceived latency | Proxies must not buffer (`X-Accel-Buffering: no`, `proxy_buffering off`) |
| React + Vite + Tailwind SPA | Component model for streaming UI, typed API payloads | Needs a Node build step (multi-stage Docker build) |
| `react-markdown` + `remark-gfm` instead of `textContent` | Structured answers (headings, lists, tables) are much easier to read; React escapes HTML by default, so no raw-HTML injection | Extra dependencies; partial Markdown may flicker while streaming |
| System prompt asks for Markdown and inline `[n]` citations | Readable, verifiable answers | Small models may produce malformed tables or ignore citation format |
| Server-side `<think>` stripping (`ThinkStripper`) | Reasoning models do not leak chain-of-thought into the UI | Hides reasoning that could help debugging (toggle with `STRIP_THINK`) |
| Documents belong to one conversation (not a shared library) | Each conversation only searches the documents it was started with; simple ownership and cleanup | The same PDF must be uploaded again to use it in another conversation (duplicate vectors) |
| Conversation filter via payload (`conversation_id` in Qdrant) | One shared collection, filtering at query time, no collection per conversation | New field, so documents indexed before this change are not reachable (re-upload them) |
| JSON state file for documents and conversations | History survives restarts without a database | Single-writer, whole file rewritten on each change; replace with Postgres/SQLite for multi-user use |
| Search log stores answer and sources (in memory, capped by `MAX_LOG_ENTRIES`) | Lets admins reopen and review any past answer without re-running it | Lost on restart; log may contain sensitive document text, so it needs access control |

## Security boundary
Qdrant and the backend share one Docker network. The backend only calls LM Studio on the host. BM25 model is baked into the image at build time, so no runtime downloads are needed.

The admin endpoints currently have no authentication. Search logs include document snippets and full answers, so they must not be exposed beyond a trusted network until auth is added.

## Known gaps / next steps
- Move documents and conversations from the JSON state file to Postgres/SQLite, and persist search logs
- Reuse a document in several conversations (attach existing documents, filter on `doc_id IN (...)` instead of `conversation_id`)
- Rename and search conversations; export a conversation
- Auth + per-document ACLs (Qdrant payload filters); protect `/api/admin/*`
- Conversation memory for the LLM: history is stored and shown, but each query is still answered statelessly, so follow-up questions ("and what about section 3?") lose context. Send recent turns to the model and rewrite follow-ups into standalone search queries
- Reranking (cross-encoder, e.g. bge-reranker) on the top 20-30 hybrid hits before building the prompt
- Better chunking: structure-aware splitting (headings, tables), larger parent context, page-level metadata
- Eval set (50 Q/A pairs): retrieval hit-rate and answer faithfulness
- Answer feedback (thumbs up/down) stored in the log to find weak retrievals
- Conflict detection across documents
- Citation UX: clickable `[n]` markers that scroll to or highlight the source, and a PDF viewer at the cited page
- Observability: structured logging, metrics (latency, token counts), tracing
- Retrieval score threshold so the model answers "I don't know" instead of using weak context
- Docker: pin image versions (`qdrant/qdrant:latest`), add healthchecks, move `version:` out of Compose (obsolete)