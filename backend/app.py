"""RAG engine (LM Studio / any OpenAI-compatible server).

Async ingestion -> hybrid retrieval (dense + BM25 in Qdrant) -> cited, streamed answers.
"""
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

import qdrant_client
from fastapi import BackgroundTasks, FastAPI, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from llama_index.core import Settings, SimpleDirectoryReader, StorageContext, VectorStoreIndex
from llama_index.core.llms import ChatMessage
from llama_index.core.node_parser import SentenceSplitter
from llama_index.core.vector_stores import MetadataFilter, MetadataFilters
from llama_index.embeddings.openai_like import OpenAILikeEmbedding
from llama_index.llms.openai_like import OpenAILike
from llama_index.vector_stores.qdrant import QdrantVectorStore
from pydantic import BaseModel
from qdrant_client.http import models as qmodels

# ---------------------------------------------------------------- config
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "http://host.docker.internal:1234/v1")
LLM_API_KEY = os.getenv("LLM_API_KEY", "lm-studio")
LLM_MODEL = os.getenv("LLM_MODEL", "local-model")
EMBED_MODEL = os.getenv("EMBED_MODEL", "text-embedding-bge-m3")
QDRANT_URL = os.getenv("QDRANT_URL", "http://qdrant:6333")
COLLECTION = os.getenv("COLLECTION", "documents")

# Pidetään hakuparametrit tiiviinä (5 parasta osumaa)
TOP_K = int(os.getenv("TOP_K", 5))
HYBRID_TOP_K = int(os.getenv("HYBRID_TOP_K", 5))

TEMPERATURE = float(os.getenv("TEMPERATURE", 0.1))
STRIP_THINK = os.getenv("STRIP_THINK", "true").lower() == "true"
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "/data/uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

Settings.llm = OpenAILike(
    model=LLM_MODEL,
    api_base=LLM_BASE_URL,
    api_key=LLM_API_KEY,
    is_chat_model=True,
    temperature=TEMPERATURE,
    timeout=300,
)
Settings.embed_model = OpenAILikeEmbedding(
    model_name=EMBED_MODEL,
    api_base=LLM_BASE_URL,
    api_key=LLM_API_KEY,
    embed_batch_size=16,
)
Settings.node_parser = SentenceSplitter(chunk_size=512, chunk_overlap=64)

# ---------------------------------------------------------------- vector store
client = qdrant_client.QdrantClient(url=QDRANT_URL)
aclient = qdrant_client.AsyncQdrantClient(url=QDRANT_URL)
store = QdrantVectorStore(
    client=client,
    aclient=aclient,
    collection_name=COLLECTION,
    enable_hybrid=True,
    fastembed_sparse_model="Qdrant/bm25",
)
storage_context = StorageContext.from_defaults(vector_store=store)
index = VectorStoreIndex.from_vector_store(store)

# ---------------------------------------------------------------- state
# Documents and conversations are persisted to a JSON file on the uploads volume, so the
# conversation history survives restarts. Search logs stay in memory.
STATE_PATH = Path(os.getenv("STATE_PATH", str(UPLOAD_DIR / "state.json")))
STATE_LOCK = threading.Lock()
DEFAULT_TITLE = "Uusi keskustelu"

DOCS: dict[str, dict] = {}  # every document belongs to exactly one conversation
CONVERSATIONS: dict[str, dict] = {}
SEARCH_LOG: list[dict] = []
MAX_LOG_ENTRIES = int(os.getenv("MAX_LOG_ENTRIES", 500))


def save_state() -> None:
    with STATE_LOCK:
        try:
            tmp = STATE_PATH.with_suffix(".tmp")
            tmp.write_text(
                json.dumps({"docs": DOCS, "conversations": CONVERSATIONS}, ensure_ascii=False),
                encoding="utf-8",
            )
            tmp.replace(STATE_PATH)
        except Exception as e:
            print(f"Failed to save state: {e}")


def load_state() -> None:
    if not STATE_PATH.exists():
        return
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"Failed to load state: {e}")
        return
    DOCS.update(data.get("docs", {}))
    CONVERSATIONS.update(data.get("conversations", {}))
    for d in DOCS.values():  # background jobs do not survive a restart
        if d.get("status") in ("queued", "processing"):
            d.update(status="failed", error="Interrupted by a server restart. Upload the file again.")
        if d.get("suggestions_status") == "pending":
            d["suggestions_status"] = "failed"


load_state()


def conv_docs(cid: str) -> list[dict]:
    return [d for d in DOCS.values() if d.get("conversation_id") == cid]


def get_conv(cid: str) -> dict:
    conv = CONVERSATIONS.get(cid)
    if not conv:
        raise HTTPException(404, "Conversation not found")
    return conv


def conv_summary(conv: dict) -> dict:
    docs = conv_docs(conv["id"])
    return {
        "id": conv["id"],
        "title": conv["title"],
        "created_at": conv["created_at"],
        "updated_at": conv["updated_at"],
        "message_count": len(conv["messages"]),
        "doc_count": len(docs),
        "doc_names": [d["name"] for d in docs],
    }


def make_title(question: str) -> str:
    t = " ".join(question.split())
    return t if len(t) <= 60 else t[:57].rstrip() + "..."

app = FastAPI(title="Local RAG Engine")

# Päivitetty prompt: vaatii inline-viitteet JA kehottaa käyttämään väliotsikoita / Markdownia
SYSTEM_PROMPT = (
    "You answer using ONLY the numbered context below. Cite sources inline as [1], [2]. "
    "If the context does not contain the answer, say you do not know based on the provided documents. "
    "If sources conflict, state both versions and cite each. Never use outside knowledge.\n\n"
    "Structure your response clearly using Markdown formatting:\n"
    "- Use subheadings (e.g. ## Section Title) to organize topics.\n"
    "- Use **bold** text for key terms and important highlights.\n"
    "- Use bullet points (- ) for lists where appropriate.\n\n"
    "CONTEXT:\n{context}"
)


# ---------------------------------------------------------------- ingestion
def generate_suggestions(docs, n: int = 3) -> list[str]:
    """Ask the LLM for a few example questions about the document, in the document's language."""
    pages = [d.text.strip() for d in docs if d.text and d.text.strip()]
    if not pages:
        return []
    step = max(1, len(pages) // 6)
    sample = "\n\n".join(p[:700] for p in pages[::step][:6])
    prompt = (
        f"Below are excerpts from a document. Write {n} short, specific questions a reader "
        "could ask about its content, each answerable from the excerpts.\n"
        "Rules: write the questions in the same language as the excerpts; "
        "max 80 characters each; no numbering; do not mention 'the document' or 'the text'.\n"
        "Return ONLY a JSON array of strings.\n\n"
        f"EXCERPTS:\n{sample}"
    )
    raw = Settings.llm.chat([ChatMessage(role="user", content=prompt)]).message.content or ""
    raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL)
    match = re.search(r"\[.*\]", raw, flags=re.DOTALL)
    if not match:
        return []
    items = json.loads(match.group(0))
    out = [q.strip() for q in items if isinstance(q, str) and 8 <= len(q.strip()) <= 120]
    return out[:n]


def purge_vectors(doc_id: str) -> None:
    try:
        client.delete(
            collection_name=COLLECTION,
            points_selector=qmodels.FilterSelector(
                filter=qmodels.Filter(
                    must=[qmodels.FieldCondition(key="doc_id", match=qmodels.MatchValue(value=doc_id))]
                )
            ),
        )
    except Exception as e:
        print(f"Error deleting vectors for {doc_id} from Qdrant: {e}")


def remove_document(doc_id: str) -> None:
    path = UPLOAD_DIR / f"{doc_id}.pdf"
    if path.exists():
        try:
            path.unlink()
        except Exception as e:
            print(f"Error removing file {path}: {e}")
    purge_vectors(doc_id)
    DOCS.pop(doc_id, None)
    save_state()


def ingest(doc_id: str, path: Path) -> None:
    """Runs in a background thread so the upload request returns immediately."""
    try:
        cid = DOCS[doc_id]["conversation_id"]
        DOCS[doc_id]["status"] = "processing"
        save_state()
        docs = SimpleDirectoryReader(input_files=[str(path)]).load_data()
        for d in docs:
            d.metadata.update(doc_id=doc_id, conversation_id=cid, source=DOCS[doc_id]["name"])
            # Random ids would only add noise to the embeddings and the LLM context.
            d.excluded_embed_metadata_keys = ["doc_id", "conversation_id"]
            d.excluded_llm_metadata_keys = ["doc_id", "conversation_id"]
        VectorStoreIndex.from_documents(docs, storage_context=storage_context)
        if doc_id not in DOCS:  # the document or its conversation was deleted while indexing
            purge_vectors(doc_id)
            return
        DOCS[doc_id].update(status="ready", pages=len(docs), suggestions=[], suggestions_status="pending")
        save_state()
        # The document is already searchable; suggestions are a bonus and must never fail the ingest.
        try:
            suggestions = generate_suggestions(docs)
        except Exception as e:
            print(f"Suggestion generation failed for {doc_id}: {e}")
            suggestions = []
        if doc_id in DOCS:
            DOCS[doc_id].update(
                suggestions=suggestions,
                suggestions_status="ready" if suggestions else "failed",
            )
            save_state()
    except Exception as e:
        if doc_id in DOCS:
            DOCS[doc_id].update(status="failed", error=str(e))
            save_state()


# ---------------------------------------------------------------- conversations
@app.post("/api/conversations", status_code=201)
def create_conversation():
    cid = uuid.uuid4().hex[:12]
    now = time.time()
    CONVERSATIONS[cid] = {
        "id": cid,
        "title": DEFAULT_TITLE,
        "created_at": now,
        "updated_at": now,
        "messages": [],
    }
    save_state()
    return conv_summary(CONVERSATIONS[cid])


@app.get("/api/conversations")
def list_conversations():
    items = [conv_summary(c) for c in CONVERSATIONS.values()]
    return sorted(items, key=lambda c: c["updated_at"], reverse=True)


@app.get("/api/conversations/{cid}")
def get_conversation(cid: str):
    conv = get_conv(cid)
    return {**conv_summary(conv), "messages": conv["messages"], "documents": conv_docs(cid)}


@app.delete("/api/conversations/{cid}")
def delete_conversation(cid: str):
    get_conv(cid)
    for d in conv_docs(cid):
        remove_document(d["id"])
    CONVERSATIONS.pop(cid, None)
    save_state()
    return {"status": "deleted", "id": cid}


# ---------------------------------------------------------------- documents
@app.post("/api/conversations/{cid}/documents", status_code=202)
async def upload(cid: str, file: UploadFile, bg: BackgroundTasks):
    conv = get_conv(cid)
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "PDF only")
    doc_id = uuid.uuid4().hex[:12]
    path = UPLOAD_DIR / f"{doc_id}.pdf"
    path.write_bytes(await file.read())
    DOCS[doc_id] = {
        "id": doc_id,
        "doc_id": doc_id,
        "conversation_id": cid,
        "name": file.filename,
        "status": "queued",
    }
    conv["updated_at"] = time.time()
    save_state()
    bg.add_task(ingest, doc_id, path)
    return DOCS[doc_id]


@app.get("/api/conversations/{cid}/documents")
def list_conversation_documents(cid: str):
    get_conv(cid)
    return conv_docs(cid)


@app.get("/api/documents")
def list_documents():
    return list(DOCS.values())


@app.delete("/api/documents/{doc_id}")
async def delete_document(doc_id: str):
    if doc_id not in DOCS:
        raise HTTPException(404, "Document not found")
    remove_document(doc_id)
    return {"status": "deleted", "doc_id": doc_id}


# ---------------------------------------------------------------- query
class Query(BaseModel):
    question: str
    conversation_id: str


class ThinkStripper:
    """Removes <think>...</think> blocks from a token stream, even when tags are split across chunks."""

    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self) -> None:
        self.buf = ""
        self.in_think = False

    @staticmethod
    def _partial_suffix(text: str, tag: str) -> int:
        for n in range(min(len(tag) - 1, len(text)), 0, -1):
            if tag.startswith(text[-n:]):
                return n
        return 0

    def feed(self, chunk: str) -> str:
        self.buf += chunk
        out = ""
        while True:
            tag = self.CLOSE if self.in_think else self.OPEN
            pos = self.buf.find(tag)
            if pos != -1:
                if not self.in_think:
                    out += self.buf[:pos]
                self.buf = self.buf[pos + len(tag):]
                self.in_think = not self.in_think
                continue
            keep = self._partial_suffix(self.buf, tag)
            emit_upto = len(self.buf) - keep
            if not self.in_think:
                out += self.buf[:emit_upto]
            self.buf = self.buf[emit_upto:]
            return out

    def flush(self) -> str:
        out = "" if self.in_think else self.buf
        self.buf = ""
        return out


def sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@app.post("/api/query")
async def query(q: Query):
    t0 = time.time()
    conv = get_conv(q.conversation_id)

    # Only search the documents that belong to this conversation.
    nodes = []
    if any(d["status"] == "ready" for d in conv_docs(conv["id"])):
        retriever = index.as_retriever(
            vector_store_query_mode="hybrid",
            similarity_top_k=TOP_K,
            sparse_top_k=TOP_K,
            hybrid_top_k=HYBRID_TOP_K,
            filters=MetadataFilters(
                filters=[MetadataFilter(key="conversation_id", value=conv["id"])]
            ),
        )
        nodes = await retriever.aretrieve(q.question)
    retrieval_ms = int((time.time() - t0) * 1000)

    sources = [
        {
            "n": i + 1,
            "doc_id": n.metadata.get("doc_id"),
            "source": n.metadata.get("source"),
            "page": n.metadata.get("page_label"),
            "score": round(n.score or 0, 4),
            "snippet": n.text[:240] if n.text else "No text extracted",
        }
        for i, n in enumerate(nodes)
    ]
    log_entry = {
        "id": uuid.uuid4().hex[:12],
        "conversation_id": conv["id"],
        "ts": time.time(),
        "question": q.question,
        "retrieved": len(nodes),
        "scores": [s["score"] for s in sources],
        "retrieval_ms": retrieval_ms,
        "total_ms": None,
        "sources": sources,
        "answer": "",
        "error": None,
    }
    SEARCH_LOG.append(log_entry)
    del SEARCH_LOG[:-MAX_LOG_ENTRIES]

    # Persist the exchange in the conversation history.
    assistant_msg = {
        "id": uuid.uuid4().hex[:12],
        "sender": "assistant",
        "text": "",
        "sources": sources,
        "retrieval_ms": retrieval_ms,
        "total_ms": None,
    }
    conv["messages"] += [
        {"id": uuid.uuid4().hex[:12], "sender": "user", "text": q.question},
        assistant_msg,
    ]
    if conv["title"] == DEFAULT_TITLE:
        conv["title"] = make_title(q.question)
    conv["updated_at"] = time.time()
    save_state()

    def finalize() -> None:
        """Runs when the stream ends, also when the client disconnects midway."""
        text = log_entry["answer"]
        if log_entry["error"]:
            text += f"\n\n⚠️ *Virhe: LLM server error: {log_entry['error']}*"
        assistant_msg["text"] = text
        assistant_msg["total_ms"] = log_entry["total_ms"]
        conv["updated_at"] = time.time()
        save_state()

    if not nodes:
        async def empty():
            try:
                yield sse("sources", [])
                msg = "No relevant documents found. Upload a document to this conversation first."
                log_entry["answer"] = msg
                yield sse("token", msg)
                yield sse("done", {})
            finally:
                finalize()
        return StreamingResponse(empty(), media_type="text/event-stream")

    context = "\n\n".join(
        f"[{s['n']}] ({s['source']}, p.{s['page']}) {n.text}" for s, n in zip(sources, nodes)
    )
    messages = [
        ChatMessage(role="system", content=SYSTEM_PROMPT.format(context=context)),
        ChatMessage(role="user", content=q.question),
    ]

    async def stream():
        yield sse("sources", sources)
        stripper = ThinkStripper() if STRIP_THINK else None
        try:
            async for chunk in await Settings.llm.astream_chat(messages):
                text = chunk.delta or ""
                if stripper:
                    text = stripper.feed(text)
                if text:
                    log_entry["answer"] += text
                    yield sse("token", text)
            if stripper:
                tail = stripper.flush()
                if tail:
                    log_entry["answer"] += tail
                    yield sse("token", tail)
            log_entry["total_ms"] = int((time.time() - t0) * 1000)
            yield sse("done", {"retrieval_ms": retrieval_ms, "total_ms": log_entry["total_ms"]})
        except Exception as e:
            log_entry["error"] = str(e)
            yield sse("error", {"message": f"LLM server error: {e}"})
        finally:
            finalize()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------- admin
@app.get("/api/admin/search-logs")
def search_logs():
    """Lightweight list for the admin table (no answer text or sources)."""
    heavy = {"answer", "sources"}
    return [{k: v for k, v in e.items() if k not in heavy} for e in SEARCH_LOG[-100:]]


@app.get("/api/admin/search-logs/{log_id}")
def search_log_detail(log_id: str):
    """Full entry: question, streamed answer and the retrieved sources."""
    for e in reversed(SEARCH_LOG):
        if e["id"] == log_id:
            return e
    raise HTTPException(404, "Log entry not found")


@app.get("/api/health")
def health():
    return {"llm": LLM_MODEL, "embeddings": EMBED_MODEL, "llm_base_url": LLM_BASE_URL, "docs": len(DOCS)}