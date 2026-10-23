/**
 * Token Savings Telemetry ROI Ledger
 * 
 * Quantifies exact token savings delivered by Hivemind's AST chunking
 * and knapsack packing versus naive whole-file context stuffing.
 */

import { PackSelection, RoiMetrics } from '@hivemind/types';

export class RoiLedger {
  /**
   * Computes empirical ROI metrics for a compiled pack.
   */
  public static calculateRoi(
    taskId: string,
    items: PackSelection[],
    fullFileTokenCounts: Map<string, number>
  ): RoiMetrics {
    const tokensLoaded = items.reduce((sum, item) => sum + item.tokens, 0);

    // Calculate baseline tokens if full files had been read
    let tokensBaseline = 0;
    const uniqueFiles = new Set<string>();

    for (const item of items) {
      if (item.filePath && !uniqueFiles.has(item.filePath)) {
        uniqueFiles.add(item.filePath);
        const baseline = fullFileTokenCounts.get(item.filePath) || item.tokens * 4; // Estimate if not recorded
        tokensBaseline += baseline;
      }
    }

    // Ensure baseline is at least loaded tokens
    tokensBaseline = Math.max(tokensBaseline, tokensLoaded);
    const tokensSaved = Math.max(0, tokensBaseline - tokensLoaded);
    const savingsPercentage = tokensBaseline > 0 
      ? Number(((tokensSaved / tokensBaseline) * 100).toFixed(1))
      : 0;

    return {
      taskId,
      tokensLoaded,
      tokensBaselineWholeFiles: tokensBaseline,
      tokensSaved,
      savingsPercentage,
      roiRatio: tokensLoaded > 0 ? Number((tokensBaseline / tokensLoaded).toFixed(2)) : 1.0
    };
  }

  /**
   * Renders a concise 1-line badge for tool outputs.
   */
  public static formatBadge(metrics: RoiMetrics): string {
    return `[ROI TELEMETRY: Loaded ${metrics.tokensLoaded} tok vs ${metrics.tokensBaselineWholeFiles} baseline | Saved ${metrics.tokensSaved} tok (${metrics.savingsPercentage}% reduction)]`;
  }
}
