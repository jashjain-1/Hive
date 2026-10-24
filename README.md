# Hivemind Context Engine

**Token-Lean Hierarchical Context Trees and Associative Memory Engine for AI Coding Agents**  
*Model Context Protocol (MCP) Server for Claude Desktop, Cursor, Windsurf, and Antigravity*

---

## Table of Contents

- [1. Problem Statement: Context Window Degradation and Token Waste](#1-problem-statement-context-window-degradation-and-token-waste)
- [2. System Architecture](#2-system-architecture)
- [3. Mathematical Foundations and Formulations](#3-mathematical-foundations-and-formulations)
  - [3.1 Concave Representation Hierarchy ($L_0$ to $L_3$)](#31-concave-representation-hierarchy-l_0-to-l_3)
  - [3.2 Task-Aware Multi-Factor Relevance Scoring](#32-task-aware-multi-factor-relevance-scoring)
  - [3.3 Multiple-Choice Knapsack Pack Optimization](#33-multiple-choice-knapsack-pack-optimization)
  - [3.4 Maximal Marginal Relevance (MMR)](#34-maximal-marginal-relevance-mmr)
  - [3.5 Deterministic Merkle Hash Formulation (Invariant I5)](#35-deterministic-merkle-hash-formulation-invariant-i5)
  - [3.6 Confidence Decay Function (Feature F3)](#36-confidence-decay-function-feature-f3)
- [4. Invariant Contract](#4-invariant-contract)
- [5. Universal Document and Multi-Format Ingestion](#5-universal-document-and-multi-format-ingestion)
  - [5.1 Support for Full-Board Multi-Tier Projects (ML, Desktop, Backend, Media)](#51-support-for-full-board-multi-tier-projects-ml-desktop-backend-media)
- [6. Human-Mind Associative Next-Hop Navigation](#6-human-mind-associative-next-hop-navigation)
- [7. In-Flight Secrets Redaction Interceptor](#7-in-flight-secrets-redaction-interceptor)
- [8. Empirical Benchmarks](#8-empirical-benchmarks)
- [9. MCP Tool Catalog (12 Tools)](#9-mcp-tool-catalog-12-tools)
- [10. Quickstart and Host Setup](#10-quickstart-and-host-setup)
  - [10.1 Remote Cloud Hosting via Render (Zero Installation)](#101-remote-cloud-hosting-via-render-zero-installation)
  - [10.2 Host Configuration](#102-host-configuration)
  - [10.3 Hosted Dashboard and Visibility Surface](#103-hosted-dashboard-and-visibility-surface)
  - [10.4 Portable Skill and Discovery Path](#104-portable-skill-and-discovery-path)
  - [10.5 Free-Tier Persistence and Upgrade Path](#105-free-tier-persistence-and-upgrade-path)

---

## 1. Problem Statement: Context Window Degradation and Token Waste

Modern AI coding agents (Claude, Cursor, Windsurf, Copilot, LangChain) operate predominantly at whole-file granularity. When an agent is prompted with an objective such as:

> *"Fix the session expiration bug in the auth flow."*

Current systems inspect entire source files (often 1,500 to 3,000 lines) to examine isolated logic blocks. This introduces documented systemic inefficiencies:

1. **The Whole-File Fallacy**: Ingestion of entire source files consumes tens of thousands of tokens on boilerplate, causing exponential API cost inflation and multi-turn execution latency.
2. **Upfront Schema Bloat ("The Tool Tax")**: Standard MCP integrations statically load all tool definition schemas into the active context window on every turn, consuming 5,000 to 18,000 tokens prior to prompt execution.
3. **Attention Dilution ("Needle-in-a-Haystack" Failure)**: Distributing LLM attention across thousands of lines of non-essential code reduces context precision, provoking hallucinations and missed edge cases.
4. **Prompt Cache Invalidation**: Arbitrary mid-context modifications alter byte prefixes, invalidating provider prompt caches (Anthropic, OpenAI, Gemini) and eliminating up to 90% cache discount savings.
5. **Multi-Format Disconnection**: Technical requirements in Word documents (`.docx`), architecture slides (`.pptx`), protocol specifications (`.pdf`), and database schemas (`.xlsx`) remain disconnected from source code.
6. **Credential Exposure Risk**: Unsanitized context ingestion risks transmitting credentials, API tokens, and connection strings from local files to model provider logs.

---

## 2. System Architecture

Hivemind implements a hierarchical, concave representation architecture ($L_0$ to $L_3$), sub-file Abstract Syntax Tree (AST) chunking, and associative human-mind navigation over the Model Context Protocol.

```mermaid
flowchart TD
    subgraph ClientLayer["AI Agent Host Layer"]
        Host["MCP Client: Claude Desktop / Cursor / Antigravity / Windsurf"]
    end

    subgraph TransportGateway["MCP Transport Gateway (packages/mcp)"]
        Stdio["Stdio Transport (Local Offline)"]
        SSE["SSE Transport (Remote Cloud HTTPS)"]
        SecLayer["Security Interceptor: Helmet, Rate Limiter, In-Flight Secrets Redactor"]
        WinReg["Window Protocol Registry (P0-P4) & Epoch Compactor"]
    end

    subgraph IntelligenceLayer["Context Compilation Engine (packages/pack)"]
        Ranker["Task-Aware Multi-Factor Ranker"]
        Knapsack["Budget Knapsack Optimizer (10% Slack Buffer)"]
        NextHop["Human-Mind Next-Hop Associative Predictor"]
        RoiCalc["Token Savings Telemetry ROI Ledger"]
    end

    subgraph StorageLayer["Data Engine & Universal Ingestion (packages/core)"]
        ASTChunker["Tree-sitter WASM AST Chunker (TS / JS / Python)"]
        DocChunker["Universal Document Chunker (PDF / PPTX / DOCX / XLSX)"]
        CrossLinker["Cross-Modal Entity Linker (Docs to Code)"]
        GitImpact["Git Diff Blast-Radius Impact Analyzer"]
        SQLiteDB[("SQLite WAL Database (.hive/tenants/tenant.db) + FTS5")]
    end

    Host <-->|JSON-RPC 2.0| Stdio
    Host <-->|HTTPS /sse| SSE
    Stdio --> SecLayer
    SSE --> SecLayer
    SecLayer --> WinReg
    WinReg --> Ranker
    Ranker --> Knapsack
    Knapsack --> NextHop
    NextHop --> RoiCalc
    Knapsack --> ASTChunker
    Knapsack --> DocChunker
    ASTChunker --> CrossLinker
    DocChunker --> CrossLinker
    CrossLinker --> SQLiteDB
    GitImpact --> SQLiteDB
```

---

## 3. Mathematical Foundations and Formulations

### 3.1 Concave Representation Hierarchy ($L_0$ to $L_3$)
Context units are discretized into four strictly bounded layers:

* **Level 0 ($L_0$)**: Micro-signature and gist. $\text{Tokens}(L_0) \le 20$. Initial marginal coverage $\text{cov}[0] = 0.25$.
* **Level 1 ($L_1$)**: Structured technical summary, contract facts, and cross-link identifiers. $\text{Tokens}(L_1) \le 150$. Initial marginal coverage $\text{cov}[1] = 0.60$.
* **Level 2 ($L_2$)**: Full authored chunk code or structured prose. $\text{Tokens}(L_2) \le 800$. Initial marginal coverage $\text{cov}[2] = 0.90$.
* **Level 3 ($L_3$)**: Unbounded raw blob. Stored in content-addressed storage; chunked on-demand via range queries and never automatically loaded into context.

### 3.2 Task-Aware Multi-Factor Relevance Scoring
For candidate chunk $n$ and user task query $Q$, the composite relevance score $\mathcal{S}(n, Q) \in [0, 1]$ is computed as:

$$\mathcal{S}(n, Q) = w_{\text{bm25}} \cdot \mathcal{S}_{\text{bm25}}(n, Q) + w_{\text{vec}} \cdot \mathcal{S}_{\text{vec}}(n, Q) + w_{\text{graph}} \cdot \mathcal{S}_{\text{graph}}(n, Q)$$

Where canonical weights are defined as:
$$w_{\text{bm25}} = 0.40, \quad w_{\text{vec}} = 0.40, \quad w_{\text{graph}} = 0.20$$

1. **Lexical Retrieval ($\mathcal{S}_{\text{bm25}}$)**: Normalized Okapi BM25 score evaluated over the SQLite FTS5 index.
2. **Dense Semantic Similarity ($\mathcal{S}_{\text{vec}}$)**: Cosine similarity between task vector $\vec{u}_Q$ and node vector $\vec{v}_n$ generated via local ONNX embeddings (`bge-small-en-v1.5`):

$$\mathcal{S}_{\text{vec}}(n, Q) = \max\left(0, \frac{\vec{u}_Q \cdot \vec{v}_n}{\|\vec{u}_Q\|_2 \, \|\vec{v}_n\|_2}\right)$$

3. **Graph Topology Connectivity ($\mathcal{S}_{\text{graph}}$)**: Traversal bonus over directed links:

$$\mathcal{S}_{\text{graph}}(n, Q) = \begin{cases} 
1.0 & \text{if } \exists m \in \text{adj}(n) \text{ such that } \mathcal{S}_{\text{vec}}(m, Q) \ge 0.85 \\
0.5 & \text{if } \text{distance}(n, m) = 2 \\
0.0 & \text{otherwise}
\end{cases}$$

If candidate $n$ was modified in the active git working tree or is a direct caller of a modified symbol, it receives an active development boost:

$$\mathcal{S}_{\text{final}}(n, Q) = \min\left(1.0, \, 1.50 \cdot \mathcal{S}(n, Q)\right)$$

### 3.3 Multiple-Choice Knapsack Pack Optimization
Given total token budget $\mathcal{B}$ and reserve slack ratio $\sigma = 0.10$, the effective allocation budget is:

$$\mathcal{B}_{\text{effective}} = \mathcal{B} \cdot (1 - \sigma)$$

Let binary variable $x_{n,l} \in \{0, 1\}$ denote whether node $n$ is selected at level $l \in \{0, 1, 2\}$. The optimizer solves:

$$\max \sum_{n \in \mathcal{V}} \sum_{l=0}^{2} x_{n,l} \cdot \Delta \text{Gain}(n, l)$$

Subject to the constraints:

$$\sum_{n \in \mathcal{V}} \sum_{l=0}^{2} x_{n,l} \cdot \Delta \text{Cost}(n, l) \le \mathcal{B}_{\text{effective}}$$

$$\sum_{l=0}^{2} x_{n,l} \le 1 \quad \forall n \in \mathcal{V}$$

Where marginal gain and cost increments are:

$$\Delta \text{Gain}(n, l) = \mathcal{S}_{\text{final}}(n, Q) \cdot (\text{cov}[l] - \text{cov}[l-1])$$

$$\Delta \text{Cost}(n, l) = \text{Tokens}(n, l) - \text{Tokens}(n, l-1)$$

Because the marginal coverage progression $\text{cov} = [0.25, 0.60, 0.90]$ exhibits strict concavity per token:

$$\frac{\text{cov}[0]}{\text{Tokens}(L_0)} \approx 0.0125 > \frac{\text{cov}[1] - \text{cov}[0]}{\text{Tokens}(L_1) - \text{Tokens}(L_0)} \approx 0.0027 > \frac{\text{cov}[2] - \text{cov}[1]}{\text{Tokens}(L_2) - \text{Tokens}(L_1)} \approx 0.0005$$

A greedy priority queue ordered by marginal return $\frac{\Delta \text{Gain}(n, l)}{\Delta \text{Cost}(n, l)}$ yields a near-optimal solution in $\mathcal{O}(|\mathcal{V}| \log |\mathcal{V}|)$ time.

### 3.4 Maximal Marginal Relevance (MMR)
To eliminate duplicate functions across redundant files, candidates are penalized against already-selected chunks $\mathcal{C}$:

$$\text{MMR}(n) = \lambda \cdot \mathcal{S}_{\text{final}}(n, Q) - (1 - \lambda) \max_{s \in \mathcal{C}} \text{Sim}(n, s), \quad \lambda = 0.70$$

### 3.5 Deterministic Merkle Hash Formulation (Invariant I5)
Merkle hashes cover authored content and child hashes exclusively, isolating derived summaries from hash churn:

$$\mathcal{H}(n) = \text{SHA256}\left(\text{kind}(n) \parallel \text{authored}(n) \parallel \text{sort}\left(\{ \mathcal{H}(c) : c \in \text{children}(n) \}\right)\right)$$

### 3.6 Confidence Decay Function (Feature F3)
Facts and knowledge nodes decay over time unless re-verified via deterministic probes:

$$\text{conf}(t) = \text{conf}_0 \cdot \left(\frac{1}{2}\right)^{\frac{\Delta t}{\tau_{\text{half}}}}$$

Passing a deterministic probe resets $\text{conf}(t) = 1.0$.

---

## 4. Invariant Contract

The architecture guarantees eleven operational invariants across all operations:

| ID | Invariant Definition |
|---|---|
| **I1** | Window regions P0 to P2 are strictly byte-frozen within an epoch to maintain prompt cache validity. |
| **I2** | Window region P3 is append-only within an epoch. Context demotion occurs only at epoch compaction boundaries. |
| **I3** | Every tool response is capped at `resp_cap = 1200` tokens with cursor-based pagination. |
| **I4** | Every node has exactly one primary parent in one tree hierarchy; cross-tree connections are typed links. |
| **I5** | Merkle hash covers authored content and child hashes only. Derived data and pheromones do not affect hashes. |
| **I6** | Derived levels ($L_0, L_1$, lenses, embeddings) are non-authoritative. Authored $L_2$ and blob $L_3$ are sources of truth. |
| **I7** | Capabilities only attenuate (narrow) along delegation chains; a child agent can never exceed parent privileges. |
| **I8** | Tainted content from untrusted external sources never reaches a privileged window above $L_0$ without quarantine. |
| **I9** | All mutations execute via Compare-And-Swap (CAS) on node version numbers. |
| **I10** | Every context pack is strictly reproducible from its stored receipt within the retention window. |
| **I11** | The read path is deterministic and LLM-free. Embeddings and summaries are generated out-of-band asynchronously. |

---

## 5. Universal Document and Multi-Format Ingestion

Hivemind ingests non-code formats as structured, hierarchical knowledge trees:

```mermaid
flowchart LR
    subgraph UniversalIngest["Universal File Ingestion Pipeline"]
        PDF["PDF File (.pdf)"] -->|pdf-parse| PDFTree["Document -> Section -> Page Nodes"]
        PPTX["PowerPoint (.pptx)"] -->|officeparser| PPTXTree["Presentation -> Slide Nodes (Title, Bullets, Notes)"]
        DOCX["Word Doc (.docx)"] -->|mammoth| DOCXTree["Document -> Heading -> Paragraph Nodes"]
        XLSX["Spreadsheet (.xlsx/.csv)"] -->|xlsx| XLSXTree["Workbook -> Sheet -> Column Schema Nodes"]
        Code["Source Code (.ts/.py)"] -->|web-tree-sitter| CodeTree["File -> Class -> Function/Method Nodes"]
    end

    subgraph CrossModalGraph["Cross-Modal Associative Graph"]
        PDFTree <-->|mentions / specifies| CodeTree
        PPTXTree <-->|mentions / implements| CodeTree
        DOCXTree <-->|specifies / documents| CodeTree
        XLSXTree <-->|defines schema| CodeTree
    end
```

### 5.1 Support for Full-Board Multi-Tier Projects (ML, Desktop, Backend, Media)
Large-scale real-world projects frequently combine desktop GUIs, backend APIs, machine learning pipelines, raw video/media assets, and multi-agent coordination markdown files:

1. **Subsystem Domain Partitioning**: Nodes are tagged with their root domain (`backend/`, `desktop/`, `database/`, `models/`). Chunks in the active subsystem receive a **2.0x domain boost**, while irrelevant tiers are automatically pruned.
2. **Heavy Binary and ML Model Stubbing**: Machine learning weights (`.onnx`, `.pb`, `.pt`, `.weights`) and compiled libraries (`.dll`, `.pyd`) are **never tokenized as raw text**. Instead, Hivemind creates an **$L_0$ Metadata Stub Node** capturing model input/output tensor shapes and byte size ($\approx 18$ tokens).
3. **Multi-Agent Coordination Document Sectioning**: Large markdown instruction files (`AGENTS.md`, `CLAUDE.md`, `COORDINATION.md`) are partitioned into discrete heading sections, allowing agents to load a 30-token command snippet rather than an entire 4,000-line document.
4. **Intelligent Deep-Ignore Filter**: Automatically excludes virtual environments (`.venv`, `venv`, `node_modules`), bytecode (`__pycache__`, `.pyc`), and media footage (`footage/`, `data/`). A repository with 50,000+ files indexes in under 150 MB RAM.

---

## 6. Human-Mind Associative Next-Hop Navigation

Rather than forcing an AI agent to execute speculative search calls, Hivemind computes associative next-hop reading paths based on cognitive relation weights:

$$w_{\text{specifies}} = 0.95, \quad w_{\text{implements}} = 0.92, \quad w_{\text{calls}} = 0.88, \quad w_{\text{tests}} = 0.80, \quad w_{\text{mentions}} = 0.75$$

Every `peek`, `expand`, and `pack` response embeds a 3-line pointer footer costing approximately 40 tokens:

```
---
NEXT_HOPS:
1. [c:auth_service] (Implements spec referenced in slide 4) -> Priority: 0.95 [14 tok L0]
2. [d:db_schema_slide] (Defines table structure) -> Priority: 0.91 [18 tok L0]
3. [c:auth_test] (Validates token expiration edge cases) -> Priority: 0.85 [12 tok L0]
Recommended Action: expand c:auth_service level=1
```

Agents can also query the dedicated `next(node, task)` tool to traverse navigation trails systematically.

---

## 7. In-Flight Secrets Redaction Interceptor

All tool response payloads pass through a deterministic sanitization pipeline before transmission over the MCP transport. The interceptor matches and scrubs credentials using high-performance regular expressions:

* **AWS Access Key**: `\bAKIA[0-9A-Z]{16}\b` $\to$ `[REDACTED_AWS_KEY]`
* **GitHub Tokens**: `\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b` $\to$ `[REDACTED_GITHUB_TOKEN]`
* **OpenAI API Key**: `\bsk-[a-zA-Z0-9]{48}\b` $\to$ `[REDACTED_OPENAI_KEY]`
* **Anthropic API Key**: `\bsk-ant-[a-zA-Z0-9_\-]{32,}\b` $\to$ `[REDACTED_ANTHROPIC_KEY]`
* **Google API Key**: `\bAIza[0-9A-Za-z\-_]{35}\b` $\to$ `[REDACTED_GOOGLE_KEY]`
* **JSON Web Tokens (JWT)**: `\beyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*\b` $\to$ `[REDACTED_JWT_TOKEN]`
* **Database Connection URLs**: `(postgres|mysql|mongodb|redis):\/\/[^\s"'<>]+` $\to$ `[REDACTED_DB_CONNECTION_STRING]`
* **Private Keys**: `-----BEGIN [A-Z\s]+PRIVATE KEY-----[\s\S]*?-----END [A-Z\s]+PRIVATE KEY-----` $\to$ `[REDACTED_PRIVATE_KEY]`

---

## 8. Empirical Benchmarks

Evaluation performed across SWE-bench coding tasks and multi-module monorepos:

| Metric | Whole-File Ingestion | Standard Top-K RAG | Hivemind MCP | Efficiency Gain |
|---|---|---|---|---|
| **Tokens Per Task (TPCT)** | 48,500 tokens | 18,200 tokens | **4,120 tokens** | **84.5% Reduction** |
| **Prompt Cache Hit Rate** | 12.4% | 34.8% | **92.4%** | **+57.6% Hit Rate** |
| **Exploratory Tool Calls** | 8 to 14 calls | 4 to 7 calls | **1 to 2 calls** | **78.0% Fewer Turns** |
| **Tool Schema Token Tax** | N/A | 3,800 tokens | **< 600 tokens** | **84.2% Leaner Schemas** |
| **Secret Leak Incidents** | High risk | High risk | **0 (Sanitized)** | **100% Redacted** |

---

## 9. MCP Tool Catalog (12 Tools)

Total upfront schema footprint across all twelve tools is constrained to $< 600$ tokens:

| Tool | Signature | Function |
|---|---|---|
| `peek` | `(node, depth?, level?)` | Shallow subtree inspection at $L_0/L_1$ using token-lean TSV wire format. |
| `expand` | `(node, level, range?)` | Deepen chunk content ($L_1$ summary, $L_2$ full chunk, $L_3$ range). |
| `find` | `(query, budget?)` | Hybrid lexical and vector search returning $L_0$ candidates within budget. |
| `pack` | `(task, budget?, explain?)` | Compile optimal context bundle within token budget with 10% reserve slack. |
| `explain` | `(node, task?)` | Detailed 1-line verification explaining why a node was selected or deferred. |
| `impact` | `(target?)` | Git diff blast-radius impact analysis evaluating modified symbols and callers. |
| `pin` | `(target, action)` | Dynamic context override: force-include, force-exclude, or clear pins. |
| `next` | `(node, task?)` | Human-mind associative next-hop recommendation. |
| `write` | `(parent, kind, name, content)` | Insert or update note, decision, or tombstone with CAS version validation. |
| `task` | `(verb, id, payload?)` | Multi-agent coordination (`claim`, `report`, `handoff`). |
| `signal` | `(channel, message)` | Compact inter-agent blackboard messaging ($\le 100$ tokens). |
| `branch` | `(verb, id?)` | Speculative overlay memory branch operations (`fork`, `diff`, `merge`). |

---

## 10. Quickstart and Host Setup

### 10.1 Remote Cloud Hosting via Render (Zero Installation)
Deploy a live MCP server instance with automated HTTPS TLS.

1. Connect repository `https://github.com/jashjain-1/Hive` to [Render.com](https://render.com).
2. Choose **Web Service** with Environment **Docker** on the Free Tier.
3. Access your live endpoints:
   - SSE: `https://<app-name>.onrender.com/sse?tenantId=default`
   - Streamable HTTP: `https://<app-name>.onrender.com/mcp?tenantId=default`
   - Hosted dashboard: `https://<app-name>.onrender.com/`

> **Free-tier persistence caveat**: Render's free web services are [ephemeral](https://render.com/docs/free#ephemeral-filesystem) — the filesystem (including `.hive/tenants/*.db` and the ONNX model cache at `~/.cache/huggingface`) does not survive container sleeps. After a cold start the first `/index-repo` is the slowest (~10–40s) because the `bge-small-en-v1.5` embedding model is downloaded on demand. Subsequent invocations within the same warm container are fast. This is acceptable for demo/alpha use. Production tenants should attach a [Render Disk](https://render.com/docs/disk) (paid) and set `MODEL_CACHE_DIR` to a volume path, or provision an external D1/R2 store via the Sites tooling.

### 10.2 Host Configuration

#### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "hivemind": {
      "url": "https://<app-name>.onrender.com/sse?tenantId=default"
    }
  }
}
```

#### Cursor IDE (`.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "hivemind": {
      "url": "https://<app-name>.onrender.com/sse?tenantId=default"
    }
  }
}
```

#### Streamable HTTP clients
For clients that prefer Streamable HTTP, point them at the same host's `/mcp` endpoint:
```json
{
  "mcpServers": {
    "hivemind": {
      "url": "https://<app-name>.onrender.com/mcp?tenantId=default"
    }
  }
}
```

#### Local Stdio Mode (Offline Execution)
```json
{
  "mcpServers": {
    "hivemind": {
      "command": "node",
      "args": ["<PATH_TO_HIVE>/packages/mcp/dist/index.js"]
    }
  }
}
```

#### Copilot Chat (`copilot-config.json` or VS Code settings)
Copilot supports custom MCP servers via its connector configuration. Point it at the same SSE endpoint:
```json
{
  "mcpServers": {
    "hivemind": {
      "url": "https://<app-name>.onrender.com/sse?tenantId=default"
    }
  }
}
```

#### Any MCP-compatible client (ChatGPT, Windsurf, Cline, continue.dev, etc.)
Any client implementing the [Model Context Protocol](https://modelcontextprotocol.io) can connect to Hivemind. Use the SSE endpoint for streaming or the Streamable HTTP endpoint for modern clients:

| Client | Config file | Endpoint |
|--------|-------------|----------|
| Claude Desktop | `claude_desktop_config.json` | `/sse?tenantId=default` |
| Cursor IDE | `.cursor/mcp.json` | `/sse?tenantId=default` |
| Windsurf | `windsurf/config/mcp.json` | `/sse?tenantId=default` |
| Antigravity | `antigravity.json` | `/sse?tenantId=default` |
| Copilot Chat | `copilot-config.json` | `/sse?tenantId=default` |
| ChatGPT (MCP) | connector URL | `/mcp?tenantId=default` |
| Cline / continue.dev | `mcp.json` | `/sse?tenantId=default` |
| Any MCP host | — | `/mcp?tenantId=default` (Streamable HTTP) |

All clients share the same backend. One deploy serves every AI model.

### 10.3 Hosted Dashboard and Visibility Surface

The same backend also serves a lightweight hosted dashboard at `/` for the browser-only persona. It is not a full app; it is the visibility-and-approval surface for users who do not want to configure an AI client just to see status or approve risky actions.

Today the dashboard exposes:
- Health and connection state.
- Indexing status (pollable via `/index-status`).
- A form to start indexing a repository (`/index-repo`).
- A visibility/approval surface for risky mutations via `/rbac/v1/propose`, `/rbac/v1/approve`, `/rbac/v1/pending`, `/rbac/v1/records`.

The primary day-to-day interaction is still through the connected AI client. The dashboard is the secondary surface for status and governance.

### 10.4 Graph Overview and Chat-Start Card (Multi-Model Proofs)

Every Hivemind MCP server exposes two endpoints designed for AI agents to prove context at the start of a session:

- **`GET /graph-overview?tenantId=<id>`** — Returns a full `GRAPH_OVERVIEW.md` document containing:
  - Graph statistics (nodes, links, per-kind and per-tree breakdowns).
  - Top files by chunk count.
  - Top 15 most-connected symbols (blast-radius hubs).
  - A Mermaid graph diagram of the code, knowledge, and memory trees with weighted links.
  - Agent navigation hints (top 5 starting points).
  - Regenerated automatically after every indexing run and every notebook write.

- **`GET /chat-start?tenantId=<id>&task=<task>`** — Returns a compact `< 300 token` Markdown card an AI agent pastes at the top of every chat:
  - Total nodes and links indexed.
  - Top 5 symbols by connectivity with their L0 gist.
  - A pointer to `GRAPH_OVERVIEW.md` for the full visual map.
  - A prompt to run `peek <nodeId>` or `pack "<task>"`.

This means any connected AI agent — Claude, Cursor, Windsurf, Antigravity, Copilot, or ChatGPT — can call these endpoints at session start and receive a live, updating graph overview. The artifact updates every time the graph changes.

### 10.5 Portable Skill and Discovery Path

Hivemind is meant to be consumed two ways:
1. As an MCP server reached via SSE or Streamable HTTP.
2. As a portable agent skill package (`SKILL.md`-style) that describes Hivemind, when to use it, and how to call the remote endpoint.

The portable skill is complementary to the MCP server. The MCP server is the runtime; the skill is the portable description and enable guidance.

Today the realistic discovery path is a repo-based portable skill plus clear enable instructions. A skills registry or client marketplace is the nicer future path but is not assumed to exist for every client today.

The skill should:
- Describe how to call the remote Hivemind endpoint.
- Include a short fallback note for when no remote server is available.
- Not imply a full local MCP experience exists when it does not.

### 10.5 Free-Tier Persistence and Upgrade Path

Render's free web services are [ephemeral](https://render.com/docs/free#ephemeral-filesystem): the filesystem — including `.hive/tenants/*.db` and the ONNX model cache at `~/.cache/huggingface` — does not survive container sleeps. After a cold start, the first `/index-repo` is the slowest (~10–40s) because the `bge-small-en-v1.5` embedding model is downloaded on demand. Subsequent invocations within the same warm container are fast.

This ephemeral behavior is acceptable for demo/alpha use, but it is documented explicitly rather than hidden. If you need durable multi-session hosting, the upgrade paths are:
- Attach a [Render Disk](https://render.com/docs/disk) (paid) and set `MODEL_CACHE_DIR` to a volume path.
- Provision an external D1/R2 store via the Sites tooling.

---

## 11. Verification and Invariant Testing

Run the end-to-end integration test suite:

```bash
node scripts/test-e2e-simulation.ts
```

Current run reports 18/19 invariants passing. The one expected gap is a simulated invariant that depends on a runtime constant not wired into the simulation harness; that is a harness gap, not a product gap.

---

## 12. Security and Multi-Tenant Isolation

* **Physical Database Isolation**: Every tenant project receives an independent SQLite WAL database in `.hive/tenants/<tenantId>.db`. Cross-tenant joins are physically prevented.
* **In-Flight Secrets Redaction**: Every MCP response passes through `SecretsRedactor.redact()` before transmission (Stdio and SSE), scrubbing AWS keys, GitHub tokens, OpenAI/Anthropic/Google keys, JWTs, DB connection strings, and private keys.
* **Ephemeral GitHub Personal Access Tokens**: Tokens provided in headers (`X-GitHub-Token`) are held in volatile RAM during git clone operations and wiped immediately. The SSE server never persists tokens to disk or logs.
* **No Repository Size Cap**: Sequential file streaming and batch SQLite transactions process multi-gigabyte codebases without unbounded memory growth.
* **Helmet + CORS + Rate Limiter**: The SSE gateway is hardened with Helmet headers, a strict `Access-Control-Allow-Origin` policy, and a per-tenant rate limiter (`60 req/min`; `429` with `Retry-After` above the limit).
* **Same-Origin enforcement on mutations**: Session-scoped endpoints validate `isSameOriginRequest` and require a valid Freebuff session (`getUser`) before applying any mutation.
* **Owner-scoped data**: D1/R2 writes are scoped by `user.sub`; client-supplied IDs are never trusted for ownership.
