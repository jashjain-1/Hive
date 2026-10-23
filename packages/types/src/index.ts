/**
 * @hivemind/types — Single Source of Truth for Hivemind MCP Backend
 * 
 * Defines all shared interfaces, DTOs, schemas, and contracts
 * across Komal (core), Anjali (pack), and Jash (mcp).
 */

// ============================================================================
// 1. NODE & LEVEL DEFINITIONS (Spec Sections 2, 4, 5)
// ============================================================================

export type TreeType = 'task' | 'memory' | 'code' | 'knowledge' | 'decision' | 'tool';

export type NodeKind = 
  | 'file'
  | 'function'
  | 'class'
  | 'interface'
  | 'method'
  | 'note'
  | 'fact'
  | 'decision'
  | 'tombstone'
  | 'summary'
  | 'task'
  | 'tool'
  | 'concept'
  // Multi-Format Document Types (Universal Ingestion)
  | 'document'                              // PDF or DOCX root
  | 'presentation'                          // PPTX root
  | 'workbook'                              // XLSX root
  | 'slide'                                 // PPTX slide node
  | 'page'                                  // PDF page node
  | 'section'                               // DOCX heading / chapter node
  | 'sheet'                                 // XLSX spreadsheet sheet node
  | 'table';                                // Structured tabular data chunk

export type NodeStatus = 
  | 'live'
  | 'claimed'
  | 'blocked'
  | 'done'
  | 'stale'
  | 'superseded'
  | 'quarantined';

export interface ChunkLocation {
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface NodeRecord {
  id: string;                               // e.g. "c:9aa31", "m:4f2a9"
  tree: TreeType;
  parent: string | null;                    // Nullable only for tree roots (Invariant I4)
  kind: NodeKind;
  name: string;                             // Symbol name or file name
  filePath?: string;
  startLine?: number;
  endLine?: number;
  status: NodeStatus;
  ver: number;                              // CAS version token (Invariant I9)
  hash: string;                             // Merkle hash: SHA256(kind | authored | sorted child hashes)
  linkHash?: string;                        // Hash of outgoing cross-links
  l0: string;                               // <= 20 tokens: signature / 1-line gist
  l1?: string;                              // <= 150 tokens: structured summary + key facts
  l2?: string;                              // <= 800 tokens: full chunk code or note prose
  blobHash?: string;                        // Pointer to L3 raw content (transcripts, oversized blobs)
  tokL0: number;                            // Measured BPE token count for L0
  tokL1: number;                            // Measured BPE token count for L1
  tokL2: number;                            // Measured BPE token count for L2
  embedding?: Float32Array;                 // 384-dim local ONNX vector embedding
  stale: boolean;
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// 2. CLOSURE & CROSS-LINKS (Spec Section 4.3, 4.4)
// ============================================================================

export type LinkRelation = 
  | 'calls'
  | 'imports'
  | 'depends_on'
  | 'implements'
  | 'supersedes'
  | 'contradicts'
  | 'tests'
  | 'blocks'
  // Cross-Modal Document-to-Code Relations
  | 'mentions'                              // Slide/Doc mentions symbol
  | 'specifies'                             // PRD/Spec defines requirements for code
  | 'documents'                             // Doc explains implementation
  | 'next_step';                            // Cognitive navigation pointer

export interface CrossLink {
  src: string;                              // Source Node ID
  dst: string;                              // Destination Node ID
  rel: LinkRelation;
  w: number;                                // Weight (default 1.0)
}

export interface ClosureEntry {
  tree: TreeType;
  anc: string;
  desc: string;
  depth: number;
}

// ============================================================================
// 3. PERSISTENT GRAPH EXPORT CONTRACT (.hive/graph.json)
// ============================================================================

export interface GraphJsonExport {
  version: '2.0';
  exportedAt: number;
  stats: {
    totalNodes: number;
    totalFiles: number;
    totalChunks: number;
    totalLinks: number;
  };
  nodes: Array<{
    id: string;
    tree: TreeType;
    parent: string | null;
    kind: NodeKind;
    name: string;
    filePath?: string;
    startLine?: number;
    endLine?: number;
    hash: string;
    l0: string;
    l1?: string;
    tokL0: number;
    tokL1: number;
  }>;
  links: CrossLink[];
}

// ============================================================================
// 4. TASK-AWARE PRIORITIZATION & PACK CONTRACTS (Spec Sections 7, 8)
// ============================================================================

export interface TaskCandidate {
  node: NodeRecord;
  level: 0 | 1 | 2;                         // Active representation level
  score: number;                            // Composite relevance score [0.0 - 1.0]
  bm25Score: number;
  vecScore: number;
  graphScore: number;
  costTokens: number;                       // Marginal token cost to load or upgrade
  marginalGain: number;                     // Marginal coverage gain / token cost
  reason: string;                           // 1-line explainable justification
}

export interface PackRequest {
  task: string;                             // e.g. "Fix JWT token expiration in auth.ts"
  budget: number;                           // Target token budget (e.g. 2000 tokens)
  slackPct?: number;                        // Reserve slack (default 0.10 -> 10%)
  explain?: boolean;                        // Whether to include explanation breakdowns
}

export interface PackSelection {
  nodeId: string;
  name: string;
  filePath?: string;
  level: 0 | 1 | 2;
  tokens: number;
  content: string;                          // L0, L1, or L2 content
  reason: string;                           // Verifiable 1-line reason for inclusion
}

export interface DeferredSelection {
  nodeId: string;
  name: string;
  filePath?: string;
  score: number;
  reason: string;                           // 1-line reason for deferral
}

export interface PackResponse {
  packId: string;
  task: string;
  budget: number;
  usedTokens: number;
  slackRemaining: number;
  items: PackSelection[];
  deferred: DeferredSelection[];
  receipt: PackReceipt;
}

export interface PackReceipt {
  packId: string;
  timestamp: number;
  asOfSeq: number;
  task: string;
  budget: number;
  paramsHash: string;
  selectedNodes: Array<{ id: string; level: number; tokens: number }>;
}

export interface ExplainNodeResult {
  nodeId: string;
  name: string;
  status: 'INCLUDED' | 'DEFERRED' | 'FORCED_INCLUDED' | 'FORCED_EXCLUDED';
  compositeScore: number;
  factors: {
    bm25: number;
    semanticVector: number;
    callGraph: number;
  };
  overrideApplied?: 'force_include' | 'force_exclude';
  justification: string;
  connectedSymbols: string[];
}

export interface OverridesConfig {
  force_include: string[];                  // Globs or symbol names
  force_exclude: string[];
}

// ============================================================================
// 4.1 HUMAN-MIND ASSOCIATIVE NAVIGATION (NEXT-HOP PREDICTION)
// ============================================================================

export interface NextHopPointer {
  nodeId: string;
  name: string;
  kind: NodeKind;
  filePath?: string;
  relation: string;                         // e.g. "implements spec", "tests edge case", "defines schema"
  priorityScore: number;                    // [0.0 - 1.0]
  tokensL0: number;                         // Minimal cost to read
  reason: string;                           // 1-line reason why the human mind views this next
}

export interface NextHopResult {
  currentNodeId: string;
  currentName: string;
  task?: string;
  recommendedHops: NextHopPointer[];
  trailDepth: number;
}

// ============================================================================
// 5. WINDOW PROTOCOL & EPOCHS (Spec Section 6)
// ============================================================================

export type WindowRegion = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

export interface WindowRegistryEntry {
  agentId: string;
  taskId: string;
  epoch: number;
  p0Protocol: string;                       // Byte-frozen across all agents
  p1Digest: string;                         // Shared byte-frozen root digest & tools
  p2RoleLens: string;                       // Role header & task breadcrumb
  p3Chunks: Array<{                         // Strictly append-only within epoch
    nodeId: string;
    level: 0 | 1 | 2;
    tokens: number;
    content: string;
  }>;
  p4Scratchpad: string;                     // Volatile reasoning & temporary output
  totalTokens: number;
  cacheHitRatio: number;
}

// ============================================================================
// 6. MCP TOOL SCHEMAS & PROTOCOL CONSTANTS
// ============================================================================

export const HIVE_CONSTANTS = {
  L0_MAX: 20,                               // Max tokens for L0 gist
  L1_MAX: 150,                              // Max tokens for L1 summary
  L2_MAX: 800,                              // Max tokens for L2 full chunk
  RESP_CAP: 1200,                           // Max tokens for any single tool response
  MSG_CAP: 100,                             // Max tokens for signal message
  SLACK_PCT: 0.10,                          // 10% budget reserve for tool follow-ups
  EPOCH_TRIGGER_PCT: 0.60,                  // Trigger compaction when P3 > 60% of budget
  FIDELITY_MIN: 0.80,                       // Round-trip fidelity floor
  DEFAULT_BUDGET: 2000
} as const;
