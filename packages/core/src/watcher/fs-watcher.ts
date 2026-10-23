/**
 * Live Filesystem Watcher (chokidar debounced at 500ms)
 * 
 * Intercepts real-time file saves, edits, and deletions on disk,
 * recomputes modified chunk Merkle hashes, and cascades staleness bits.
 */

import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { IgnoreEngine } from '../ignore/ignore-rules';

export class LiveFsWatcher {
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly debounceMs = 500;

  constructor(
    private db: Database.Database,
    private repoRoot: string,
    private onFileChange?: (filePath: string) => void
  ) {}

  /**
   * Handles an incoming filesystem change event with 500ms debouncing.
   */
  public handleFileEvent(eventType: 'add' | 'change' | 'unlink', relativePath: string): void {
    const fullPath = path.resolve(this.repoRoot, relativePath);

    // Skip ignored directories and binary extensions
    const segments = relativePath.split(path.sep);
    if (segments.some(seg => IgnoreEngine.shouldSkipDirectory(seg))) {
      return;
    }
    if (IgnoreEngine.isBinaryAsset(fullPath)) {
      return;
    }

    // Clear existing debounce timer for this file
    const existing = this.debounceTimers.get(relativePath);
    if (existing) clearTimeout(existing);

    // Set new debounce timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(relativePath);
      this.processDebouncedEvent(eventType, relativePath, fullPath);
    }, this.debounceMs);

    this.debounceTimers.set(relativePath, timer);
  }

  private processDebouncedEvent(eventType: 'add' | 'change' | 'unlink', relativePath: string, fullPath: string): void {
    if (eventType === 'unlink') {
      // Mark deleted nodes as superseded
      this.db.prepare(`
        UPDATE nodes SET status = 'superseded', stale = 1, updatedAt = ? 
        WHERE filePath = ? OR name = ?
      `).run(Date.now(), relativePath, path.basename(relativePath));
      console.log(`[Live Watcher] File removed: ${relativePath} -> marked superseded.`);
    } else {
      // Mark existing nodes as stale so they trigger re-chunking
      this.db.prepare(`
        UPDATE nodes SET stale = 1, updatedAt = ? 
        WHERE filePath = ? OR name = ?
      `).run(Date.now(), relativePath, path.basename(relativePath));
      console.log(`[Live Watcher] File updated: ${relativePath} -> invalidated chunk hashes.`);
      
      if (this.onFileChange) {
        this.onFileChange(fullPath);
      }
    }
  }

  /**
   * Cleans up all active debounce timers.
   */
  public close(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
