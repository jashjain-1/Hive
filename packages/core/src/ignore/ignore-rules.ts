/**
 * Full-Board Project Ignore Engine
 * 
 * Prevents memory exhaustion and token waste when indexing massive,
 * polyglot full-board repositories (e.g. multi-service apps, ML pipelines,
 * virtual environments, compiled binaries, and heavy media assets).
 */

import path from 'path';

export class IgnoreEngine {
  // Directory patterns always excluded from deep AST parsing
  public static readonly IGNORED_DIRECTORIES: Set<string> = new Set([
    '.venv',
    'venv',
    'env',
    '.env',
    'node_modules',
    '.git',
    '.obsidian',
    '.pytest_cache',
    '.ruff_cache',
    '__pycache__',
    'build',
    'dist',
    'footage',
    'data',
    '.idea',
    '.vscode'
  ]);

  // File extensions that are heavy binaries, model weights, or media
  // (Stubbed as lightweight L0 metadata nodes rather than parsed as text)
  public static readonly BINARY_EXTENSIONS: Set<string> = new Set([
    // ML weights & model graphs
    '.onnx', '.pb', '.pt', '.pth', '.bin', '.weights', '.h5', '.tflite', '.engine',
    // Compiled native code & bytecode
    '.pyc', '.pyo', '.pyd', '.dll', '.so', '.dylib', '.exe', '.obj', '.lib',
    // Media & video footage
    '.mp4', '.avi', '.mkv', '.mov', '.jpg', '.jpeg', '.png', '.gif', '.wav', '.mp3',
    // Compressed archives
    '.zip', '.tar', '.gz', '.7z', '.rar'
  ]);

  /**
   * Checks whether a directory should be skipped during repository walk.
   */
  public static shouldSkipDirectory(dirName: string): boolean {
    return this.IGNORED_DIRECTORIES.has(dirName) || dirName.startsWith('.');
  }

  /**
   * Checks whether a file is a binary asset that requires L0 stubbing rather than text tokenization.
   */
  public static isBinaryAsset(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.BINARY_EXTENSIONS.has(ext);
  }

  /**
   * Determines the Subsystem Domain based on file path in a full-board repository.
   * e.g., 'backend/api/auth.py' -> 'backend'
   *       'desktop/ui/main.qml' -> 'desktop'
   *       'database/schema.sql' -> 'database'
   *       'models/yolo.py'      -> 'models'
   */
  public static extractSubsystem(filePath: string, repoRoot: string): string {
    const relative = path.relative(repoRoot, filePath);
    const segments = relative.split(path.sep);
    if (segments.length > 1) {
      return segments[0]; // First-level directory represents the subsystem
    }
    return 'root';
  }
}
