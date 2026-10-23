/**
 * Overrides & Dynamic Pinning Manager
 * 
 * Manages persistent context pins in .hive/overrides.json and allows
 * agents to dynamically force-include or force-exclude files on the fly.
 */

import fs from 'fs';
import path from 'path';
import { NodeRecord, OverridesConfig, PinAction, PinResponse } from '@hivemind/types';

export class OverridesManager {
  private configPath: string;

  constructor(repoRoot: string = process.cwd()) {
    this.configPath = path.join(repoRoot, '.hive', 'overrides.json');
    this.ensureConfigFile();
  }

  private ensureConfigFile(): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(this.configPath)) {
      const defaultContent: OverridesConfig = {
        force_include: [],
        force_exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**']
      };
      fs.writeFileSync(this.configPath, JSON.stringify(defaultContent, null, 2), 'utf8');
    }
  }

  public loadConfig(): OverridesConfig {
    try {
      this.ensureConfigFile();
      const raw = fs.readFileSync(this.configPath, 'utf8');
      return JSON.parse(raw) as OverridesConfig;
    } catch {
      return { force_include: [], force_exclude: [] };
    }
  }

  public saveConfig(config: OverridesConfig): void {
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  /**
   * Applies dynamic pin action (include, exclude, clear) and updates .hive/overrides.json.
   */
  public updatePin(target: string, action: PinAction): PinResponse {
    const config = this.loadConfig();

    // Clean target from both arrays first
    config.force_include = config.force_include.filter(t => t !== target);
    config.force_exclude = config.force_exclude.filter(t => t !== target);

    if (action === 'include') {
      config.force_include.push(target);
    } else if (action === 'exclude') {
      config.force_exclude.push(target);
    }

    this.saveConfig(config);

    return {
      target,
      action,
      activeIncludes: config.force_include,
      activeExcludes: config.force_exclude,
      message: action === 'clear' 
        ? `Cleared context pins for "${target}".` 
        : `Successfully applied pin action "${action}" on "${target}".`
    };
  }

  /**
   * Partitions candidate nodes into forcedIncludes, forcedExcludes, and normal candidates.
   */
  public filter(candidates: NodeRecord[]): { forcedIncludes: NodeRecord[]; forcedExcludes: NodeRecord[] } {
    const config = this.loadConfig();
    const forcedIncludes: NodeRecord[] = [];
    const forcedExcludes: NodeRecord[] = [];

    for (const node of candidates) {
      const targetStr = node.filePath || node.name;
      const isIncluded = this.matches(targetStr, config.force_include);
      const isExcluded = this.matches(targetStr, config.force_exclude);

      if (isIncluded) {
        forcedIncludes.push(node);
      } else if (isExcluded) {
        forcedExcludes.push(node);
      }
    }

    return { forcedIncludes, forcedExcludes };
  }

  /** Returns true when the target path or name matches any of the glob patterns. */
  public matches(target: string, patterns: string[]): boolean {
    return this.matchingPattern(target, patterns) !== undefined;
  }

  /** Returns the first glob pattern matching the target, if any. */
  public matchingPattern(target: string, patterns: string[]): string | undefined {
    const normalized = target.replace(/\\/g, '/').replace(/^\.\//, '');
    return patterns.find(pattern => this.globToRegExp(pattern).test(normalized));
  }

  /**
   * Converts a Git-style glob into an anchored regular expression.
   * Supports `**` (any depth, including none), `*` (within one path segment),
   * and `?` (single non-separator character). Patterns without a slash match
   * the file name at any depth, matching .gitignore-style expectations.
   */
  private globToRegExp(pattern: string): RegExp {
    const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
    const expanded = normalized.includes('/') ? normalized : `**/${normalized}`;

    let source = '';
    for (let i = 0; i < expanded.length; i++) {
      const char = expanded[i];
      if (char === '*') {
        if (expanded[i + 1] === '*') {
          i++;
          if (expanded[i + 1] === '/') {
            i++;
            source += '(?:.*/)?';
          } else {
            source += '.*';
          }
        } else {
          source += '[^/]*';
        }
      } else if (char === '?') {
        source += '[^/]';
      } else if ('\\^$+?.()|{}[]'.includes(char)) {
        source += `\\${char}`;
      } else {
        source += char;
      }
    }

    return new RegExp(`^${source}$`);
  }
}
