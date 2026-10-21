import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  FileText,
  Upload,
  Trash2,
  Send,
  Cpu,
  Database,
  Activity,
  ChevronDown,
  ChevronUp,
  Sparkles,
  MessageSquare,
  ShieldAlert,
  CheckCircle2,
  Clock,
  FileCode,
  RefreshCw,
  Layers,
  Plus,
} from "lucide-react";

const PROSE =
  "text-slate-100 text-sm leading-relaxed prose prose-sm prose-invert max-w-none prose-headings:text-cyan-300 prose-headings:font-bold prose-h2:text-base prose-h2:mt-4 prose-h2:mb-1 prose-h3:text-sm prose-h3:mt-3 prose-h3:mb-1 prose-strong:text-cyan-200 prose-p:my-2 prose-li:my-0.5 prose-ul:my-2 prose-ol:my-2 prose-hr:my-4 prose-hr:border-slate-700 prose-th:text-cyan-300 prose-th:font-semibold prose-th:text-left prose-th:px-3 prose-th:py-2 prose-td:px-3 prose-td:py-2 prose-thead:border-slate-600 prose-tr:border-slate-800";

function Markdown({ children }: { children: string }) {
  return (
    <div className={PROSE}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ children }) => (
            <div className="overflow-x-auto my-3 rounded-lg border border-slate-800">
              <table className="m-0 w-full">{children}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

interface DocumentItem {
  id: string;
  doc_id?: string;
  name: string;
  status: "queued" | "processing" | "ready" | "failed";
  pages?: number;
  error?: string;
  suggestions?: string[];
  suggestions_status?: "pending" | "ready" | "failed";
}

interface SourceCitation {
  n: number;
  doc_id?: string;
  source: string;
  page?: string | number;
  score: number;
  snippet: string;
}

interface Message {
  id: string;
  sender: "user" | "assistant";
  text: string;
  sources?: SourceCitation[];
  isStreaming?: boolean;
  retrieval_ms?: number;
  total_ms?: number;
}

interface SearchLog {
  id: string;
  ts: number;
  question: string;
  retrieved: number;
  scores: number[];
  retrieval_ms: number;
  total_ms?: number | null;
  answer?: string;
  sources?: SourceCitation[];
  error?: string | null;
  conversation_id?: string | null;
}

interface HealthStatus {
  llm: string;
  embeddings: string;
  llm_base_url: string;
  docs: number;
}

interface ConversationSummary {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  doc_count: number;
  doc_names: string[];
}

const WELCOME_MESSAGE: Message = {
  id: "welcome",
  sender: "assistant",
  text: "Hei! Olen paikallinen RAG-avustajasi. Lataa PDF-dokumentteja vasemmasta paneelista ja esitä minulle kysymyksiä dokumenttiesi sisällöstä.",
};

const formatConvTime = (ts: number) => {
  const d = new Date(ts * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("fi-FI", { day: "numeric", month: "numeric" });
};

export default function App() {
  const [activeTab, setActiveTab] = useState<"chat" | "admin">("chat");
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [isHealthLoading, setIsHealthLoading] = useState(false);

  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  // null = draft conversation: it is created on the server with the first upload or question.
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const activeConvRef = useRef<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [inputQuery, setInputQuery] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  const [searchLogs, setSearchLogs] = useState<SearchLog[]>([]);
  const [selectedLog, setSelectedLog] = useState<SearchLog | null>(null);
  const [isLogDetailLoading, setIsLogDetailLoading] = useState(false);
  const [isLogsLoading, setIsLogsLoading] = useState(false);

  const [expandedSources, setExpandedSources] = useState<{
    [msgId: string]: boolean;
  }>({});

  const fetchDocuments = async (cid: string | null = activeConvRef.current) => {
    if (!cid) return;
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(cid)}/documents`);
      // Ignore late responses that belong to a conversation the user has already left.
      if (res.ok && activeConvRef.current === cid) {
        setDocuments(await res.json());
      }
    } catch (e) {
      console.error("Failed to fetch documents:", e);
    }
  };

  const fetchConversations = async () => {
    try {
      const res = await fetch("/api/conversations");
      if (res.ok) setConversations(await res.json());
    } catch (e) {
      console.error("Failed to fetch conversations:", e);
    }
  };

  const ensureConversation = async (): Promise<string> => {
    if (activeConvRef.current) return activeConvRef.current;
    const res = await fetch("/api/conversations", { method: "POST" });
    if (!res.ok) throw new Error("Keskustelun luonti epäonnistui");
    const conv: ConversationSummary = await res.json();
    activeConvRef.current = conv.id;
    setActiveConvId(conv.id);
    fetchConversations();
    return conv.id;
  };

  const selectConversation = async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
      if (!res.ok) return false;
      const conv: { messages: Message[]; documents: DocumentItem[] } = await res.json();
      activeConvRef.current = id;
      setActiveConvId(id);
      setMessages([WELCOME_MESSAGE, ...conv.messages]);
      setDocuments(conv.documents);
      setExpandedSources({});
      return true;
    } catch (e) {
      console.error("Failed to open conversation:", e);
      return false;
    }
  };

  const startNewConversation = () => {
    activeConvRef.current = null;
    setActiveConvId(null);
    setMessages([WELCOME_MESSAGE]);
    setDocuments([]);
    setExpandedSources({});
    setActiveTab("chat");
  };

  const handleDeleteConversation = async (id: string) => {
    if (!confirm("Poistetaanko keskustelu ja sen dokumentit?")) return;
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        alert("Keskustelun poisto epäonnistui.");
        return;
      }
      if (activeConvRef.current === id) startNewConversation();
      fetchConversations();
    } catch (e) {
      alert("Virhe poistopyynnössä.");
    }
  };

  const fetchHealth = async () => {
    setIsHealthLoading(true);
    try {
      const res = await fetch("/api/health");
      if (res.ok) {
        const data = await res.json();
        setHealth(data);
      }
    } catch (e) {
      console.error("Failed to fetch health status:", e);
    } finally {
      setIsHealthLoading(false);
    }
  };

  const fetchLogs = async () => {
    setIsLogsLoading(true);
    try {
      const res = await fetch("/api/admin/search-logs");
      if (res.ok) {
        const data = await res.json();
        setSearchLogs(data.reverse());
      }
    } catch (e) {
      console.error("Failed to fetch search logs:", e);
    } finally {
      setIsLogsLoading(false);
    }
  };

  const openLog = async (id: string) => {
    setIsLogDetailLoading(true);
    try {
      const res = await fetch(`/api/admin/search-logs/${encodeURIComponent(id)}`);
      if (res.ok) setSelectedLog(await res.json());
    } catch (e) {
      console.error("Failed to fetch log detail:", e);
    } finally {
      setIsLogDetailLoading(false);
    }
  };

  const openLogConversation = async (log: SearchLog) => {
    if (log.conversation_id && (await selectConversation(log.conversation_id))) {
      setSelectedLog(null);
      setActiveTab("chat");
    } else {
      alert("Keskustelua ei löydy enää (se on voitu poistaa).");
    }
  };

  useEffect(() => {
    fetchHealth();
    fetchConversations();
  }, []);

  useEffect(() => {
    if (!activeConvId) return;
    fetchDocuments(activeConvId);
    const interval = setInterval(() => fetchDocuments(activeConvId), 4000);
    return () => clearInterval(interval);
  }, [activeConvId]);

  useEffect(() => {
    if (activeTab === "admin") {
      fetchLogs();
    }
  }, [activeTab]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleFileUpload = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      alert("Vain PDF-tiedostot ovat sallittuja.");
      return;
    }

    setIsUploading(true);
    const formData = new FormData();
    formData.append("file", file);

    try {
      const cid = await ensureConversation();
      const res = await fetch(`/api/conversations/${encodeURIComponent(cid)}/documents`, {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        await Promise.all([fetchDocuments(cid), fetchConversations()]);
      } else {
        const err = await res.json();
        alert(`Virhe latauksessa: ${err.detail || "Tuntematon virhe"}`);
      }
    } catch (e) {
      alert("Virhe tiedoston lähettämisessä palvelimelle.");
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteDocument = async (docId: string) => {
    if (!confirm("Haluatko varmasti poistaa tämän dokumentin?")) return;

    try {
      const res = await fetch(`/api/documents/${docId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setDocuments((prev) =>
          prev.filter((d) => (d.id || d.doc_id) !== docId)
        );
        fetchConversations();
      } else {
        alert("Dokumentin poisto epäonnistui.");
      }
    } catch (e) {
      alert("Virhe poistopyynnössä.");
    }
  };

  const handleSendQuery = async (queryText?: string) => {
    const textToSend = queryText || inputQuery;
    if (!textToSend.trim() || isGenerating) return;

    let cid: string;
    try {
      cid = await ensureConversation();
    } catch (e) {
      alert("Keskustelun luonti epäonnistui.");
      return;
    }

    const userMsgId = Date.now().toString();
    const assistantMsgId = (Date.now() + 1).toString();

    const userMessage: Message = {
      id: userMsgId,
      sender: "user",
      text: textToSend,
    };

    const initialAssistantMsg: Message = {
      id: assistantMsgId,
      sender: "assistant",
      text: "",
      sources: [],
      isStreaming: true,
    };

    setMessages((prev) => [...prev, userMessage, initialAssistantMsg]);
    if (!queryText) setInputQuery("");
    setIsGenerating(true);

    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: textToSend, conversation_id: cid }),
      });

      if (!response.ok || !response.body) {
        throw new Error("Palvelinvirhe pyyntöä käsiteltäessä.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;

          const eventMatch = line.match(/^event:\s*(.+)$/m);
          const dataMatch = line.match(/^data:\s*(.+)$/m);

          if (eventMatch && dataMatch) {
            const eventType = eventMatch[1].trim();
            const rawData = dataMatch[1].trim();

            try {
              const data = JSON.parse(rawData);

              if (eventType === "sources") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMsgId ? { ...msg, sources: data } : msg
                  )
                );
              } else if (eventType === "token") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMsgId
                      ? { ...msg, text: msg.text + data }
                      : msg
                  )
                );
              } else if (eventType === "done") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMsgId
                      ? {
                          ...msg,
                          isStreaming: false,
                          retrieval_ms: data.retrieval_ms,
                          total_ms: data.total_ms,
                        }
                      : msg
                  )
                );
              } else if (eventType === "error") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMsgId
                      ? {
                          ...msg,
                          text: msg.text + `\n\n⚠️ *Virhe: ${data.message}*`,
                          isStreaming: false,
                        }
                      : msg
                  )
                );
              }
            } catch (err) {
              console.error("SSE parsing error:", err);
            }
          }
        }
      }
    } catch (error: any) {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId
            ? {
                ...msg,
                text: `Yhteyttä palvelimeen ei saatu muodostettua. Virhe: ${error.message}`,
                isStreaming: false,
              }
            : msg
        )
      );
    } finally {
      setIsGenerating(false);
      fetchConversations();
    }
  };

  const toggleSourceExpand = (msgId: string) => {
    setExpandedSources((prev) => ({ ...prev, [msgId]: !prev[msgId] }));
  };

  const SUMMARY_PROMPT = "Yhteenveto ladatusta dokumentista";
  const readyDocs = documents.filter((d) => d.status === "ready");
  const isSuggesting = readyDocs.some((d) => d.suggestions_status === "pending");
  // Interleave suggestions across documents so each one gets a question, max 3 in total.
  const generatedPrompts: string[] = [];
  for (let i = 0; i < 3; i++) {
    for (const d of readyDocs) {
      const q = d.suggestions?.[i];
      if (q && generatedPrompts.length < 3 && !generatedPrompts.includes(q)) {
        generatedPrompts.push(q);
      }
    }
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 text-slate-100 font-sans antialiased overflow-hidden selection:bg-cyan-500/30 selection:text-cyan-200">
      <header className="h-16 border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-md px-6 flex items-center justify-between z-10">
        <div className="flex items-center space-x-3">
          <div className="p-2 rounded-xl bg-gradient-to-tr from-cyan-500/20 to-blue-600/20 border border-cyan-500/30 text-cyan-400">
            <Cpu className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <h1 className="font-bold text-lg tracking-tight bg-gradient-to-r from-cyan-400 via-sky-200 to-indigo-300 bg-clip-text text-transparent">
              Local RAG Engine
            </h1>
            <p className="text-xs text-slate-400 font-mono">
              Qdrant Hybrid Retrieval + Stream LLM
            </p>
          </div>
        </div>

        <div className="flex bg-slate-950/70 p-1 rounded-xl border border-slate-800">
          <button
            onClick={() => setActiveTab("chat")}
            className={`flex items-center space-x-2 px-4 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === "chat"
                ? "bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shadow-sm"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Chat</span>
          </button>
          <button
            onClick={() => setActiveTab("admin")}
            className={`flex items-center space-x-2 px-4 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === "admin"
                ? "bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shadow-sm"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>Admin Logs</span>
          </button>
        </div>

        <div className="hidden md:flex items-center space-x-4 text-xs font-mono bg-slate-900/80 border border-slate-800 px-3 py-1.5 rounded-lg">
          <div className="flex items-center space-x-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            <span className="text-slate-300">
              {health?.llm || "LLM Online"}
            </span>
          </div>
          <span className="text-slate-700">|</span>
          <div className="flex items-center space-x-1.5 text-slate-400">
            <Database className="w-3.5 h-3.5 text-cyan-400" />
            <span>{health?.embeddings || "text-embedding-bge-m3"}</span>
          </div>
          <button
            onClick={fetchHealth}
            title="Päivitä tila"
            className="text-slate-500 hover:text-cyan-400 transition-colors pl-1"
          >
            <RefreshCw
              className={`w-3 h-3 ${isHealthLoading ? "animate-spin" : ""}`}
            />
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-80 border-r border-slate-800/80 bg-slate-900/40 backdrop-blur-sm flex flex-col p-4 flex-shrink-0">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center space-x-2 text-slate-300 font-semibold text-sm">
              <MessageSquare className="w-4 h-4 text-cyan-400" />
              <span>Keskustelut</span>
            </div>
            <button
              onClick={startNewConversation}
              disabled={isGenerating}
              className="flex items-center space-x-1 text-xs px-2 py-1 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/20 transition-colors disabled:opacity-50"
            >
              <Plus className="w-3 h-3" />
              <span>Uusi</span>
            </button>
          </div>

          <div className="max-h-56 overflow-y-auto space-y-1 pr-1 mb-4">
            {conversations.length === 0 ? (
              <div className="text-center py-4 text-slate-500 text-xs border border-slate-800/60 border-dashed rounded-xl">
                Ei aiempia keskusteluja.
              </div>
            ) : (
              conversations.map((c) => (
                <div
                  key={c.id}
                  className={`group flex items-start rounded-xl border transition-all ${
                    c.id === activeConvId
                      ? "bg-cyan-500/10 border-cyan-500/30"
                      : "bg-slate-900/60 border-slate-800/80 hover:border-slate-700"
                  }`}
                >
                  <button
                    onClick={() => selectConversation(c.id)}
                    disabled={isGenerating}
                    className="flex-1 min-w-0 text-left p-2.5 disabled:opacity-60"
                  >
                    <p className="text-xs font-medium text-slate-200 truncate" title={c.title}>
                      {c.title}
                    </p>
                    <p
                      className="text-[10px] text-slate-500 truncate mt-0.5"
                      title={c.doc_names.join(", ")}
                    >
                      {c.doc_count > 0 ? c.doc_names.join(", ") : "Ei dokumentteja"}
                    </p>
                    <p className="text-[10px] font-mono text-slate-600 mt-0.5">
                      {formatConvTime(c.updated_at)} · {Math.floor(c.message_count / 2)} kysymystä
                    </p>
                  </button>
                  <button
                    onClick={() => handleDeleteConversation(c.id)}
                    disabled={isGenerating}
                    title="Poista keskustelu"
                    className="p-2 text-slate-600 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-all disabled:opacity-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center space-x-2 text-slate-300 font-semibold text-sm">
              <Layers className="w-4 h-4 text-cyan-400" />
              <span>Keskustelun dokumentit</span>
            </div>
            <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
              {documents.length} kpl
            </span>
          </div>

          <label className="border-2 border-dashed border-slate-800 hover:border-cyan-500/50 bg-slate-950/40 hover:bg-cyan-950/10 rounded-xl p-4 flex flex-col items-center justify-center cursor-pointer transition-all group mb-4">
            <input
              type="file"
              accept=".pdf"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.[0]) {
                  handleFileUpload(e.target.files[0]);
                }
              }}
            />
            <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 group-hover:border-cyan-500/30 text-slate-400 group-hover:text-cyan-400 transition-all mb-2">
              <Upload
                className={`w-5 h-5 ${isUploading ? "animate-bounce text-cyan-400" : ""}`}
              />
            </div>
            <span className="text-xs font-medium text-slate-300 group-hover:text-cyan-300">
              {isUploading ? "Ladataan..." : "Pudota PDF tai hae koneelta"}
            </span>
            <span className="text-[10px] text-slate-500 mt-1">
              Vain PDF-tiedostot tuettu
            </span>
          </label>

          <div className="flex-1 overflow-y-auto space-y-2 pr-1">
            {documents.length === 0 ? (
              <div className="text-center py-8 text-slate-500 text-xs border border-slate-800/60 border-dashed rounded-xl p-4">
                Tässä keskustelussa ei ole dokumentteja. Lataa PDF aloittaaksesi haun.
              </div>
            ) : (
              documents.map((doc) => {
                const docId = doc.id || doc.doc_id || "";
                return (
                  <div
                    key={docId}
                    className="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80 hover:border-slate-700 transition-all flex items-center justify-between group shadow-sm"
                  >
                    <div className="flex items-center space-x-3 overflow-hidden">
                      <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex-shrink-0">
                        <FileText className="w-4 h-4" />
                      </div>
                      <div className="overflow-hidden">
                        <p
                          className="text-xs font-medium text-slate-200 truncate group-hover:text-cyan-200 transition-colors"
                          title={doc.name}
                        >
                          {doc.name}
                        </p>
                        <div className="flex items-center space-x-2 mt-1">
                          {doc.status === "ready" && (
                            <span className="inline-flex items-center text-[10px] font-mono text-emerald-400 bg-emerald-950/40 px-1.5 py-0.5 rounded border border-emerald-800/50">
                              <CheckCircle2 className="w-2.5 h-2.5 mr-1" />
                              {doc.pages ? `${doc.pages} sivua` : "valmis"}
                            </span>
                          )}
                          {doc.status === "processing" && (
                            <span className="inline-flex items-center text-[10px] font-mono text-amber-400 bg-amber-950/40 px-1.5 py-0.5 rounded border border-amber-800/50">
                              <RefreshCw className="w-2.5 h-2.5 mr-1 animate-spin" />
                              käsitellään
                            </span>
                          )}
                          {doc.status === "queued" && (
                            <span className="inline-flex items-center text-[10px] font-mono text-sky-400 bg-sky-950/40 px-1.5 py-0.5 rounded border border-sky-800/50">
                              <Clock className="w-2.5 h-2.5 mr-1" />
                              jonossa
                            </span>
                          )}
                          {doc.status === "failed" && (
                            <span className="inline-flex items-center text-[10px] font-mono text-rose-400 bg-rose-950/40 px-1.5 py-0.5 rounded border border-rose-800/50">
                              <ShieldAlert className="w-2.5 h-2.5 mr-1" />
                              virhe
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={() => handleDeleteDocument(docId)}
                      title="Poista dokumentti"
                      className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        <main className="flex-1 flex flex-col bg-slate-950 relative overflow-hidden">
          {activeTab === "chat" && (
            <div className="flex-1 flex flex-col h-full overflow-hidden">
              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${
                      msg.sender === "user" ? "items-end" : "items-start"
                    }`}
                  >
                    <div className="flex items-center space-x-2 mb-1.5 px-1">
                      {msg.sender === "assistant" ? (
                        <>
                          <div className="p-1 rounded-md bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                            <Sparkles className="w-3 h-3" />
                          </div>
                          <span className="text-xs font-semibold text-slate-400">
                            RAG AI Engine
                          </span>
                          {msg.total_ms && (
                            <span className="text-[10px] font-mono text-slate-500 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">
                              {msg.total_ms}ms
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-xs font-semibold text-slate-400">
                          Sinä
                        </span>
                      )}
                    </div>

                    <div
                      className={`max-w-3xl rounded-2xl p-4 text-sm leading-relaxed shadow-lg ${
                        msg.sender === "user"
                          ? "bg-gradient-to-r from-cyan-600 to-blue-600 text-white rounded-tr-none"
                          : "bg-slate-900/90 border border-slate-800 text-slate-200 rounded-tl-none shadow-cyan-950/10"
                      }`}
                    >
                      {msg.text ? (
                        <Markdown>{msg.text}</Markdown>
                      ) : msg.isStreaming ? (
                        <div className="flex items-center space-x-2 text-cyan-400 py-1">
                          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-bounce" />
                          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-bounce [animation-delay:0.2s]" />
                          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-bounce [animation-delay:0.4s]" />
                          <span className="text-xs text-slate-400 ml-2">
                            Muodostetaan vastausta...
                          </span>
                        </div>
                      ) : null}

                      {msg.sources && msg.sources.length > 0 && (
                        <div className="mt-4 pt-3 border-t border-slate-800">
                          <button
                            onClick={() => toggleSourceExpand(msg.id)}
                            className="flex items-center justify-between w-full text-xs text-slate-400 hover:text-cyan-300 py-1 transition-colors group"
                          >
                            <div className="flex items-center space-x-2">
                              <FileCode className="w-3.5 h-3.5 text-cyan-400" />
                              <span className="font-medium">
                                Lähdeviitteet ({msg.sources.length} kpl)
                              </span>
                            </div>
                            <div className="flex items-center space-x-1 text-[11px] text-slate-500">
                              <span>
                                {expandedSources[msg.id]
                                  ? "Piilota"
                                  : "Näytä kaikki"}
                              </span>
                              {expandedSources[msg.id] ? (
                                <ChevronUp className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5" />
                              )}
                            </div>
                          </button>

                          <div className="mt-2 space-y-2">
                            {(expandedSources[msg.id]
                              ? msg.sources
                              : msg.sources.slice(0, 3)
                            ).map((src) => (
                              <div
                                key={src.n}
                                className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80 hover:border-slate-700 transition-all text-xs"
                              >
                                <div className="flex items-center justify-between mb-1">
                                  <div className="flex items-center space-x-2 truncate">
                                    <span className="w-4 h-4 rounded-full bg-cyan-500/20 text-cyan-300 text-[10px] font-mono flex items-center justify-center font-bold border border-cyan-500/30 flex-shrink-0">
                                      {src.n}
                                    </span>
                                    <span
                                      className="font-medium text-slate-300 truncate"
                                      title={src.source}
                                    >
                                      {src.source}
                                    </span>
                                    {src.page && (
                                      <span className="text-[10px] text-slate-500 font-mono">
                                        sivulla {src.page}
                                      </span>
                                    )}
                                  </div>

                                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-cyan-400 flex-shrink-0">
                                    Score: {(src.score * 100).toFixed(1)}%
                                  </span>
                                </div>

                                <p className="text-[11px] text-slate-400 italic bg-slate-900/40 p-2 rounded border border-slate-800/50 mt-1 line-clamp-2">
                                  "{src.snippet}"
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={chatBottomRef} />
              </div>

              <div className="px-6 py-2 flex items-center space-x-2 overflow-x-auto">
                <span className="text-[11px] text-slate-500 font-medium flex items-center space-x-1 flex-shrink-0">
                  <Sparkles className="w-3 h-3 text-cyan-400" />
                  <span>Kokeile:</span>
                </span>
                {isSuggesting && (
                  <span className="text-[11px] text-slate-500 flex-shrink-0 animate-pulse">
                    Luodaan ehdotuksia...
                  </span>
                )}
                {[...generatedPrompts, SUMMARY_PROMPT].map((promptText, i) => (
                  <button
                    key={i}
                    onClick={() => handleSendQuery(promptText)}
                    disabled={isGenerating}
                    className="text-xs px-3 py-1 rounded-full bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-cyan-300 transition-all flex-shrink-0 whitespace-nowrap disabled:opacity-50"
                  >
                    {promptText}
                  </button>
                ))}
              </div>

              <div className="p-4 border-t border-slate-800/80 bg-slate-900/30 backdrop-blur-md">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSendQuery();
                  }}
                  className="flex items-center space-x-3 max-w-4xl mx-auto"
                >
                  <div className="relative flex-1">
                    <input
                      type="text"
                      value={inputQuery}
                      onChange={(e) => setInputQuery(e.target.value)}
                      placeholder="Kysy mitä tahansa ladatuista dokumenteista..."
                      disabled={isGenerating}
                      className="w-full bg-slate-900 border border-slate-800 focus:border-cyan-500/50 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20 transition-all"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={!inputQuery.trim() || isGenerating}
                    className="p-3 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium shadow-lg shadow-cyan-950/50 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center flex-shrink-0"
                  >
                    <Send
                      className={`w-4 h-4 ${isGenerating ? "animate-spin" : ""}`}
                    />
                  </button>
                </form>
              </div>
            </div>
          )}

          {activeTab === "admin" && (
            <div className="flex-1 p-6 overflow-y-auto">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-lg font-bold text-slate-100">
                    Hakutietokanta & Lokit
                  </h2>
                  <p className="text-xs text-slate-400">
                    Viimeisimmät 100 kyselyä ja niiden suoritusajat
                  </p>
                </div>

                <button
                  onClick={fetchLogs}
                  className="flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-300 hover:text-cyan-300 transition-colors"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${isLogsLoading ? "animate-spin" : ""}`}
                  />
                  <span>Päivitä lokit</span>
                </button>
              </div>

              <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-900/40 backdrop-blur-sm">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-900 border-b border-slate-800 text-slate-400 font-mono">
                      <th className="p-3">Aika</th>
                      <th className="p-3">Kysymys</th>
                      <th className="p-3">Palasia haettu</th>
                      <th className="p-3">Paras Pistemäärä</th>
                      <th className="p-3">Hakuviive</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {searchLogs.length === 0 ? (
                      <tr>
                        <td
                          colSpan={5}
                          className="p-6 text-center text-slate-500"
                        >
                          Ei hakulogeja saatavilla vielä.
                        </td>
                      </tr>
                    ) : (
                      searchLogs.map((log, idx) => {
                        const topScore =
                          log.scores && log.scores.length > 0
                            ? Math.max(...log.scores)
                            : 0;
                        return (
                          <tr
                            key={log.id ?? idx}
                            onClick={() => log.id && openLog(log.id)}
                            className="hover:bg-slate-900/60 transition-colors cursor-pointer"
                          >
                            <td className="p-3 font-mono text-slate-500 whitespace-nowrap">
                              {new Date(log.ts * 1000).toLocaleTimeString()}
                            </td>
                            <td className="p-3 font-medium text-slate-200">
                              {log.question}
                            </td>
                            <td className="p-3 font-mono text-cyan-400">
                              {log.retrieved} pcs
                            </td>
                            <td className="p-3 font-mono">
                              <span className="px-2 py-0.5 rounded bg-emerald-950/50 border border-emerald-800/50 text-emerald-400">
                                {(topScore * 100).toFixed(1)}%
                              </span>
                            </td>
                            <td className="p-3 font-mono text-slate-400">
                              {log.retrieval_ms} ms
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {(selectedLog || isLogDetailLoading) && (
                <div
                  className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
                  onClick={() => setSelectedLog(null)}
                >
                  <div
                    className="w-full max-w-4xl max-h-[85vh] overflow-y-auto rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-2xl"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {!selectedLog ? (
                      <p className="text-sm text-slate-400">Ladataan...</p>
                    ) : (
                      <>
                        <div className="flex items-start justify-between gap-4 mb-4">
                          <div>
                            <p className="text-xs font-mono text-slate-500">
                              {new Date(selectedLog.ts * 1000).toLocaleString()} ·{" "}
                              haku {selectedLog.retrieval_ms} ms
                              {selectedLog.total_ms
                                ? ` · yhteensä ${selectedLog.total_ms} ms`
                                : ""}
                            </p>
                            <h3 className="mt-1 text-base font-bold text-slate-100">
                              {selectedLog.question}
                            </h3>
                          </div>
                          <button
                            onClick={() => setSelectedLog(null)}
                            className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-300 hover:text-cyan-300"
                          >
                            Sulje
                          </button>
                        </div>

                        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                          {selectedLog.answer ? (
                            <Markdown>{selectedLog.answer}</Markdown>
                          ) : (
                            <p className="text-sm text-slate-500">
                              Vastausta ei tallennettu (kysely kesken tai epäonnistui).
                            </p>
                          )}
                          {selectedLog.error && (
                            <p className="mt-2 text-xs text-red-400">
                              {selectedLog.error}
                            </p>
                          )}
                        </div>

                        {selectedLog.sources && selectedLog.sources.length > 0 && (
                          <div className="mt-4 grid gap-2 sm:grid-cols-2">
                            {selectedLog.sources.map((src) => (
                              <div
                                key={src.n}
                                className="rounded-lg border border-slate-800 border-l-2 border-l-cyan-500 bg-slate-900/40 p-3 text-xs text-slate-400"
                              >
                                <p className="font-semibold text-slate-200">
                                  [{src.n}] {src.source}, s.{src.page ?? "?"}{" "}
                                  <span className="font-mono text-cyan-400">
                                    ({(src.score * 100).toFixed(1)}%)
                                  </span>
                                </p>
                                <p className="mt-1">{src.snippet}</p>
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="mt-5 flex justify-end">
                          <button
                            onClick={() => openLogConversation(selectedLog)}
                            className="px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 text-sm font-medium text-white"
                          >
                            Avaa keskustelu
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}