

# Local RAG Engine

> **"Data privacy is the #1 blocker for enterprise AI adoption in Europe and Finland."**
> Companies must manage, secure and keep full ownership of their data. **LocalVault RAG Engine** tackles this with a fully local Retrieval-Augmented Generation (RAG) platform: no cloud APIs, no telemetry, and no internet access needed at runtime.

Ask questions about your own PDF documents and get answers that cite their sources, while every document, embedding and prompt stays on your own hardware.

---
## 🤖 Recommended Models & Setup

To get the best performance out of the hybrid retrieval and markdown rendering, the system has been tested and optimized with the following local setup via LM Studio:

- **LLM (Inference):** Qwen-based instruction models (e.g., Qwen 3.8 9B / custom Finnish-distilled variants quantized at `Q4_K_M`).
- **Embedding Model:** `text-embedding-bge-m3` (optimized for dense multilingual embeddings, highly recommended for Finnish, English, and Swedish document retrieval).
---

## 🎯 Motivation: why local RAG?

Cloud LLM APIs are quick to integrate, but European enterprises, public-sector organizations and legal or financial institutions face GDPR obligations, compliance requirements and IP-leak risks when internal documents are sent to external endpoints.

This project shows that **you don't need to send proprietary data to a third-party provider to build a modern AI assistant.** With local models, a vector database and hybrid search, an organization can keep its data on its own hardware or private infrastructure.

---

## 💡 Use cases

- **Legal & compliance review:** query NDAs, contracts and regulatory filings without exposing client confidentiality.
- **Healthcare & medical research:** search clinical documentation and internal procedures while keeping the data inside your own environment.
- **Finance & auditing:** search internal reports, documents and audit trails without sending sensitive figures outside the company.
- **Public sector & restricted environments:** process internal documentation inside isolated networks where no internet egress is allowed.
- **Internal technical knowledge base:** let engineering teams query specifications, wiki exports and technical PDFs safely.

---

## ✨ Features

- 🛡️ **Local-first:** embeddings, retrieval and LLM inference all run on your machine or private server. After the containers are built, no internet connection is required.
- 🔍 **Hybrid retrieval:** dense embeddings (`bge-m3` via LM Studio) combined with sparse BM25 keyword matching (`fastembed`) in Qdrant. Multilingual: Finnish, English and Swedish documents.
- ⚡ **Streaming answers over SSE:** sources arrive first, then tokens. Reasoning models are supported, since `<think>...</think>` blocks are stripped on the server (`STRIP_THINK`).
- 🗂️ **Conversation history:** every conversation keeps its messages, sources and documents. Past conversations can be reopened from the sidebar and survive restarts.
- 🏷️ **Isolated conversation contexts:** each conversation owns its uploaded PDFs. Retrieval is filtered by `conversation_id` in Qdrant, so documents never leak between conversations.
- 💬 **Suggested questions:** after upload, the LLM generates a few example questions in the document's language. A "summary" shortcut is always available.
- 📑 **Rich Markdown answers:** headings, lists, bold text, GitHub-style tables (in a horizontally scrollable container) and inline `[n]` citations with expandable source snippets.
- 📊 **Admin log viewer:** inspect retrieval latency, scores and the exact sources behind past queries. Open any log entry to see the full answer or jump to its conversation.

> The user interface is currently in Finnish.

---

## 🛠️ Architecture

```text
┌───────────────────────────────────────────────────────────────┐
│                        CLIENT BROWSER                         │
│     React + TypeScript + Tailwind CSS (served by Nginx)       │
└───────────────────────────────┬───────────────────────────────┘
                                │ HTTP / SSE stream  (/api/*)
                                ▼
┌───────────────────────────────────────────────────────────────┐
│                       FASTAPI BACKEND                         │
│  Conversations · ingestion · retrieval · streaming · logs     │
│  State file (state.json): documents + conversations           │
└───────────────┬───────────────────────────────┬───────────────┘
                │ dense + sparse search         │ chat + embeddings
                ▼                               ▼
┌───────────────────────────┐   ┌───────────────────────────────┐
│          QDRANT           │   │          LM STUDIO            │
│  Vector + BM25 hybrid     │   │  OpenAI-compatible server     │
│  index (Docker)           │   │  running on the host          │
└───────────────────────────┘   └───────────────────────────────┘
```

**Data flow**

- **Upload:** PDF → API (`202 Accepted`) → background ingestion → chunking → dense embedding (LM Studio) + sparse BM25 (fastembed) → Qdrant, tagged with `doc_id` and `conversation_id`.
- **Query:** question + `conversation_id` → hybrid retrieval filtered to that conversation's documents → numbered-context prompt → LM Studio → SSE stream (sources, tokens, done). The exchange is saved to the conversation history.

**Tech stack**

| Layer | Technology |
|---|---|
| Frontend | React, TypeScript, Vite, Tailwind CSS, Lucide icons, `react-markdown` + `remark-gfm` |
| Backend | Python, FastAPI, LlamaIndex, Uvicorn |
| Vector database | Qdrant (Docker) |
| Sparse index | FastEmbed BM25 (model baked into the container image) |
| LLM / embeddings | LM Studio, or any OpenAI-compatible server (vLLM, llama.cpp server, ...) |
| Deployment | Docker Compose, Nginx reverse proxy (SSE buffering disabled) |

More detail and the decision log are in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 🚀 Quickstart

### Prerequisites

1. **Docker** and **Docker Compose**.
2. **LM Studio** running on the host machine:
   - Load an embedding model, e.g. `text-embedding-bge-m3`.
   - Load a chat model, e.g. a Qwen 2.5 Instruct model.
   - Start the local server (default `http://localhost:1234/v1`).

   On Linux, make sure the LM Studio server is reachable from Docker containers (not bound to `127.0.0.1` only). The Compose file maps `host.docker.internal` to the host.

### Run with Docker Compose

```bash
git clone https://github.com/your-username/local-rag-engine.git
cd local-rag-engine

# Check the environment section of the backend service in docker-compose.yml
# (LLM_BASE_URL, LLM_MODEL, EMBED_MODEL) and adjust it to your LM Studio setup.

docker compose up -d --build
```

Open **http://localhost:3000**. Qdrant's dashboard is at http://localhost:6333/dashboard and the API at http://localhost:8000/docs.

Create a conversation by uploading a PDF or asking a question, then ask questions about the document.

### Local development (without Docker for the app)

```bash
# 1. Qdrant
docker compose up -d qdrant

# 2. Backend (Python 3.11+)
cd backend
pip install -r requirements.txt
QDRANT_URL=http://localhost:6333 UPLOAD_DIR=./data/uploads \
  uvicorn app:app --reload --port 8000

# 3. Frontend
cd frontend
npm install
npm run dev        # http://localhost:5173, /api is proxied to port 8000
```

---

## ⚙️ Configuration

All settings are environment variables of the backend service (set them in `docker-compose.yml`).

| Variable | Default | Description |
|---|---|---|
| `LLM_BASE_URL` | `http://host.docker.internal:1234/v1` | OpenAI-compatible endpoint for chat and embeddings |
| `LLM_API_KEY` | `lm-studio` | API key sent to the endpoint (any value for LM Studio) |
| `LLM_MODEL` | `local-model` | Chat model identifier |
| `EMBED_MODEL` | `text-embedding-bge-m3` | Embedding model identifier |
| `QDRANT_URL` | `http://qdrant:6333` | Qdrant address |
| `COLLECTION` | `documents` | Qdrant collection name |
| `TOP_K`, `HYBRID_TOP_K` | `5`, `5` | Number of retrieved chunks (dense/sparse, and after fusion) |
| `TEMPERATURE` | `0.1` | LLM sampling temperature |
| `STRIP_THINK` | `true` | Remove `<think>` blocks from streamed answers |
| `UPLOAD_DIR` | `/data/uploads` | Where uploaded PDFs are stored |
| `STATE_PATH` | `<UPLOAD_DIR>/state.json` | Persisted documents and conversations |
| `MAX_LOG_ENTRIES` | `500` | Search-log entries kept in memory |

Data is persisted in two Docker volumes: `qdrant_data` (vectors) and `rag_data` (PDFs and `state.json`).

---

## 📡 API overview

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/conversations` | `POST` / `GET` | Create a conversation / list conversations (newest first) |
| `/api/conversations/{id}` | `GET` / `DELETE` | Get a conversation with messages and documents / delete it together with its documents, files and vectors |
| `/api/conversations/{id}/documents` | `POST` / `GET` | Upload a PDF (async ingestion, `202`) / list the conversation's documents and their status |
| `/api/documents/{doc_id}` | `DELETE` | Delete one document (file, vectors, state entry) |
| `/api/query` | `POST` | Hybrid retrieval over the conversation's documents, streamed as SSE (`sources`, `token`, `done`, `error`) |
| `/api/admin/search-logs` | `GET` | Last 100 queries: scores, retrieval latency |
| `/api/admin/search-logs/{id}` | `GET` | Full log entry: question, answer, sources, timings |
| `/api/health` | `GET` | Model names, LLM base URL, document count |

Interactive API docs are served by FastAPI at `/docs` on port 8000.

---

## 🛡️ Security boundary & production considerations

- **Network boundary:** Qdrant and the backend communicate only inside the Docker network, and the backend calls only your local LM Studio server. No internet access is needed after the images are built.
- **No authentication yet:** all endpoints, including `/api/admin/*`, are open. Search logs and conversation history contain document text and full answers. For anything beyond a trusted network, put the app behind an authentication proxy (e.g. OAuth2-Proxy or Authelia) or add access control to the API.
- **State storage:** documents and conversations live in a single JSON file, and search logs are in memory. This is fine for a single-user setup; use a database for multi-user deployments.
- **Background ingestion:** it runs in-process and does not survive a restart (interrupted uploads are marked as failed). Use a job queue such as Celery + Redis in production.

---

## 🛣️ Roadmap

- [ ] Move state from `state.json` to PostgreSQL/SQLite and persist search logs
- [ ] Multi-turn memory: send recent turns to the LLM and rewrite follow-up questions into standalone search queries
- [ ] Cross-encoder reranking (e.g. `bge-reranker`) on the hybrid top hits
- [ ] Clickable `[n]` citation markers with a PDF viewer at the cited page
- [ ] Reuse a document across several conversations
- [ ] Authentication and role-based access control (RBAC) with per-document permissions
- [ ] Evaluation set (50 Q/A pairs) for retrieval hit-rate and answer faithfulness
- [ ] Retrieval score threshold so weak context leads to "I don't know"

---
