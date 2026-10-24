/**
 * In-Flight Secrets Redaction Interceptor
 * 
 * Automatically detects and scrubs credentials, API keys, private keys,
 * and database connection strings before text payloads are returned to LLMs.
 */

export class SecretsRedactor {
  private static readonly RULES: Array<{ pattern: RegExp; replacement: string }> = [
    // AWS Access Key ID
    { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED_AWS_KEY]' },
    
    // GitHub Personal Access Tokens
    { pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
    { pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g, replacement: '[REDACTED_GITHUB_PAT]' },

    // Anthropic API Key (must precede the generic sk- rule)
    { pattern: /\bsk-ant-[a-zA-Z0-9_\-]{32,}/g, replacement: '[REDACTED_ANTHROPIC_KEY]' },

    // OpenAI API Key (classic sk- and project/service-account sk-proj- forms)
    { pattern: /\bsk-(?!ant-)[a-zA-Z0-9_\-]{20,}/g, replacement: '[REDACTED_OPENAI_KEY]' },

    // Google Cloud / Gemini API Key
    { pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g, replacement: '[REDACTED_GOOGLE_KEY]' },

    // Generic JSON Web Token (JWT)
    { pattern: /\beyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*\b/g, replacement: '[REDACTED_JWT_TOKEN]' },

    // Database Connection Strings
    { pattern: /(postgres|postgresql|mysql|mongodb|redis|mssql):\/\/[^\s"'<>]+/gi, replacement: '[REDACTED_DB_CONNECTION_STRING]' },

    // Private Keys (RSA, EC, OpenSSH, PGP)
    { pattern: /-----BEGIN [A-Z\s]+PRIVATE KEY-----[\s\S]*?-----END [A-Z\s]+PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },

    // Common Password assignments in code/configs
    { pattern: /(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']([^"']{8,})["']/gi, replacement: '$1: "[REDACTED_CREDENTIAL]"' },

    // x-access-token PATs embedded in HTTPS URLs (collapse the token portion)
    { pattern: /([\w\-]+\.com\/)(x-access-token:)([a-zA-Z0-9_\-]{20,})/gi, replacement: '$1[REDACTED_GITHUB_TOKEN_IN_URL]' },

    // Private/loopback IPv4 literals inside URLs (SSRF exfiltration indicators).
    { pattern: /https?:\/\/(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?/gi, replacement: '[REDACTED_PRIVATE_IP_URL]' },
    { pattern: /https?:\/\/192\.168\.\d{1,3}\.\d{1,3}(?::\d+)?/gi, replacement: '[REDACTED_PRIVATE_IP_URL]' },
    { pattern: /https?:\/\/172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?::\d+)?/gi, replacement: '[REDACTED_PRIVATE_IP_URL]' },
    { pattern: /https?:\/\/169\.254\.\d{1,3}\.\d{1,3}(?::\d+)?/gi, replacement: '[REDACTED_PRIVATE_IP_URL]' },
  ];

  /**
   * Redacts sensitive secrets from the target string.
   */
  public static redact(text: string): string {
    if (!text || typeof text !== 'string') return text;

    let sanitized = text;
    // Avoid pathological regex backtracking on very large blobs.
    if (sanitized.length > 200_000) {
      sanitized = sanitized.slice(0, 200_000) + sanitized.slice(-1_000);
    }
    for (const rule of this.RULES) {
      try {
        sanitized = sanitized.replace(rule.pattern, rule.replacement);
      } catch {
        // If a rule catastrophically backtracks on odd input, keep the text and skip it.
        continue;
      }
    }
    return sanitized;
  }
}
