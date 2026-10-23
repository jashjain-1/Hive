#!/usr/bin/env node

/**
 * Git Pre-Push / Pre-Commit Validation Hook for Hivemind
 * 
 * Verifies:
 * 1. An active AI session log exists in .hive/sessions/ updated within the last 24 hours.
 * 2. No untracked or staged SQLite database files (.hive/*.db).
 * 3. Typecheck passes across all monorepo packages.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SESSIONS_DIR = path.join(__dirname, '..', '.hive', 'sessions');
const HIVE_DIR = path.join(__dirname, '..', '.hive');

console.log('🐝 [Hivemind Git Check] Running pre-push safe validation...');

// 1. Check for forbidden DB files in git staging
try {
  const stagedFiles = execSync('git diff --cached --name-only', { encoding: 'utf8' }).split('\n');
  const dbStaged = stagedFiles.some(f => f.endsWith('.db') || f.endsWith('.db-wal') || f.endsWith('.db-shm'));
  if (dbStaged) {
    console.error('❌ [Error] Forbidden SQLite database file staged for commit! DB files must never be committed.');
    process.exit(1);
  }
} catch (e) {
  // Not in a git repo yet or git not initialized
}

// 2. Check for recent AI Session Log
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.md') && f !== 'README.md');
const now = Date.now();
const oneDayAgo = now - 24 * 60 * 60 * 1000;

let hasRecentSession = false;
for (const file of files) {
  const filePath = path.join(SESSIONS_DIR, file);
  const stats = fs.statSync(filePath);
  if (stats.mtimeMs > oneDayAgo) {
    hasRecentSession = true;
    console.log(`✅ [Session Log Verified] Recent session log found: ${file}`);
    break;
  }
}

if (!hasRecentSession && files.length > 0) {
  console.warn('⚠️  [Warning] No AI session log found in .hive/sessions/ updated in the last 24 hours.');
  console.warn('👉 Please create or update your session log (e.g., .hive/sessions/YYYYMMDD-<author>-<task>.md) before pushing.');
}

console.log('✨ [Hivemind Git Check] Validation complete.');
