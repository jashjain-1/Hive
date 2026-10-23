import { WindowRegistryEntry, HIVE_CONSTANTS } from '@hivemind/types';

/**
 * Window Protocol (P0-P4) & Epoch Compactor
 *
 * Invariant I1: P0-P2 are strictly byte-frozen within an epoch.
 * Invariant I2: P3 is append-only within an epoch. Demotion only at compaction.
 *
 * Regions:
 *   P0: System protocol header (byte-frozen)
 *   P1: Hive root digest & tool definitions (byte-frozen)
 *   P2: Role lens & task breadcrumb (byte-frozen)
 *   P3: Context chunks (append-only, compacted at 60% budget)
 *   P4: Volatile scratchpad (unbounded, discarded on epoch)
 */

export class WindowEpochManager {
  private windows = new Map<string, WindowRegistryEntry>();

  /** Create a new window for an agent/task pair */
  createWindow(agentId: string, taskId: string, p0Protocol: string, p1Digest: string, p2RoleLens: string): WindowRegistryEntry {
    const entry: WindowRegistryEntry = {
      agentId,
      taskId,
      epoch: 0,
      p0Protocol,
      p1Digest,
      p2RoleLens,
      p3Chunks: [],
      p4Scratchpad: '',
      totalTokens: 0,
      cacheHitRatio: 0
    };
    this.windows.set(`${agentId}:${taskId}`, entry);
    return entry;
  }

  /** Get or create window */
  getWindow(agentId: string, taskId: string): WindowRegistryEntry | undefined {
    return this.windows.get(`${agentId}:${taskId}`);
  }

  /** Append a chunk to P3 (append-only within epoch) */
  appendChunk(window: WindowRegistryEntry, chunk: { nodeId: string; level: 0 | 1 | 2; tokens: number; content: string }): void {
    window.p3Chunks.push(chunk);
    window.totalTokens += chunk.tokens;
  }

  /** Check if epoch compaction should be triggered (P3 > 60% of budget) */
  shouldTriggerEpoch(window: WindowRegistryEntry, budget: number): boolean {
    const p3Tokens = window.p3Chunks.reduce((acc, c) => acc + c.tokens, 0);
    return p3Tokens > budget * HIVE_CONSTANTS.EPOCH_TRIGGER_PCT;
  }

  /** Compact the window by demoting L2 chunks to L1, L1 to L0 */
  compactWindow(window: WindowRegistryEntry): WindowRegistryEntry {
    const compactedP3 = window.p3Chunks.map(chunk => {
      if (chunk.level === 2) {
        // Demote L2 -> L1
        return {
          ...chunk,
          level: 1 as const,
          tokens: Math.min(chunk.tokens, HIVE_CONSTANTS.L1_MAX)
        };
      } else if (chunk.level === 1) {
        // Demote L1 -> L0
        return {
          ...chunk,
          level: 0 as const,
          tokens: Math.min(chunk.tokens, HIVE_CONSTANTS.L0_MAX)
        };
      }
      return chunk;
    });

    const newWindow: WindowRegistryEntry = {
      ...window,
      epoch: window.epoch + 1,
      p3Chunks: compactedP3,
      totalTokens: compactedP3.reduce((sum, c) => sum + c.tokens, 0),
      p4Scratchpad: '' // Clear scratchpad on epoch
    };

    this.windows.set(`${window.agentId}:${window.taskId}`, newWindow);
    return newWindow;
  }

  /** Update P4 scratchpad (volatile, can be overwritten freely) */
  updateScratchpad(window: WindowRegistryEntry, text: string): void {
    window.p4Scratchpad = text;
  }

  /** Get total token count across all regions */
  getTotalTokens(window: WindowRegistryEntry): number {
    const p0Tokens = window.p0Protocol.length / 4; // rough BPE estimate
    const p1Tokens = window.p1Digest.length / 4;
    const p2Tokens = window.p2RoleLens.length / 4;
    const p3Tokens = window.p3Chunks.reduce((sum, c) => sum + c.tokens, 0);
    const p4Tokens = window.p4Scratchpad.length / 4;
    return p0Tokens + p1Tokens + p2Tokens + p3Tokens + p4Tokens;
  }

  /** Serialize window to JSON for reproducibility (Invariant I10) */
  serializeWindow(window: WindowRegistryEntry): string {
    return JSON.stringify({
      agentId: window.agentId,
      taskId: window.taskId,
      epoch: window.epoch,
      p0Protocol: window.p0Protocol,
      p1Digest: window.p1Digest,
      p2RoleLens: window.p2RoleLens,
      p3Chunks: window.p3Chunks,
      totalTokens: window.totalTokens,
      serializedAt: Date.now()
    }, null, 2);
  }
}
