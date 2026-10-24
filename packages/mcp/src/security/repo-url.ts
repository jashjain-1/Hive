/**
 * Repo URL validation for the hosted indexing endpoint.
 *
 * The hosted server can be told to `git clone` an arbitrary URL. That makes URL
 * validation a security boundary, not a convenience: without it the endpoint is an
 * SSRF primitive (cloud metadata, internal git servers, localhost services) and a
 * command-injection surface once the value reaches a shell.
 *
 * Policy:
 *   - https only (no http, git://, ssh://, file://, data:, etc.)
 *   - host must be in ALLOWED_INDEX_HOSTS
 *   - no embedded credentials (tokens travel in a header, never in the URL)
 *   - no shell metacharacters anywhere in path or query
 *   - resolved IP must not be private/loopback/link-local (checked by the caller, which
 *     owns DNS; `isPrivateIpv4` / `isPrivateIpv6` are exported for that check)
 */

export const ALLOWED_INDEX_HOSTS = new Set([
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'gist.githubusercontent.com',
]);

export interface IndexRepoValidation {
  repoUrl: string;
  host: string;
  /** Normalised URL without a trailing `.git` or trailing slash, for display. */
  hint?: string;
}

/** Characters that must never appear in a repo URL that we hand to git. */
const FORBIDDEN_URL_CHARS: string[] = [
  ';', '&', '|', '`', '$', '(', ')', '{', '}', '[', ']', '!', '#', '~', '*', '<', '>',
  '"', String.fromCharCode(39), String.fromCharCode(92), ' ',
  String.fromCharCode(9), String.fromCharCode(10), String.fromCharCode(13),
];

const FORBIDDEN_SCHEMES = /\b(file|ftp|gopher|data|javascript|vbscript|mailto|telnet|ssh|sftp|scp|svn|hg):/i;

/**
 * RFC 1918 / loopback / link-local / CGNAT / benchmark / multicast / reserved IPv4.
 */
export function isPrivateIpv4(addr: string): boolean {
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c, d] = nums;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && b === 18) ||
    (a === 198 && b === 51 && c === 100) ||
    a === 224 ||
    a >= 240
  );
}

/** Loopback, unique-local, link-local, unspecified, and IPv4-mapped private ranges. */
export function isPrivateIpv6(addr: string): boolean {
  const value = addr.toLowerCase();
  return (
    value === '::' ||
    value === '::1' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe80') ||
    value.startsWith('fec0') ||
    value.startsWith('::ffff:127.') ||
    value.startsWith('::ffff:10.') ||
    value.startsWith('::ffff:192.168.') ||
    value.startsWith('::ffff:172.16.') ||
    value.startsWith('::ffff:169.254.')
  );
}

export function hasForbiddenUrlChars(value: string): boolean {
  return FORBIDDEN_URL_CHARS.some((ch) => value.includes(ch));
}

export function validateIndexRepoUrl(raw: string): IndexRepoValidation | { error: string } {
  if (!raw || typeof raw !== 'string') {
    return { error: 'repoUrl must be a non-empty string.' };
  }

  const trimmed = raw.trim();

  // Check the raw input as well as the parsed parts: the WHATWG URL parser percent-encodes
  // characters such as backticks, so a path-only check would let `` `whoami` `` through as
  // `%60whoami%60` and lose the signal that the caller sent shell syntax.
  if (hasForbiddenUrlChars(trimmed)) {
    return { error: 'repoUrl contains characters that are not allowed.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: 'repoUrl is not a valid URL.' };
  }

  if (parsed.protocol !== 'https:') {
    return { error: 'Only https Git URLs are accepted for indexing.' };
  }

  if (FORBIDDEN_SCHEMES.test(parsed.pathname) || FORBIDDEN_SCHEMES.test(parsed.search)) {
    return { error: 'Unsupported URL scheme. Only https Git URLs are accepted.' };
  }

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_INDEX_HOSTS.has(host)) {
    return {
      error: `Git hosts other than ${[...ALLOWED_INDEX_HOSTS].join(', ')} are not accepted by this deployment.`,
    };
  }

  if (parsed.username || parsed.password) {
    return { error: 'Repo URLs must not contain embedded credentials. Use the X-GitHub-Token header instead.' };
  }

  if (hasForbiddenUrlChars(parsed.pathname) || hasForbiddenUrlChars(parsed.search)) {
    return { error: 'repoUrl contains characters that are not allowed.' };
  }

  const cleanPath = parsed.pathname.replace(/\.git$/i, '').replace(/\/+$/, '');
  return { repoUrl: parsed.href, host, hint: `https://${host}${cleanPath}` };
}
