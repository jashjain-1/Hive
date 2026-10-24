import { describe, it, expect } from 'vitest';
import {
  validateIndexRepoUrl,
  isPrivateIpv4,
  isPrivateIpv6,
  hasForbiddenUrlChars,
} from '../src/security/repo-url.js';

function errorFor(url: string): string {
  const result = validateIndexRepoUrl(url);
  if (!('error' in result)) {
    throw new Error(`expected rejection, got acceptance for ${url}`);
  }
  return result.error;
}

describe('validateIndexRepoUrl — accepted', () => {
  it('accepts a github https URL and normalises the hint', () => {
    const result = validateIndexRepoUrl('https://github.com/owner/repo.git');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.host).toBe('github.com');
    expect(result.hint).toBe('https://github.com/owner/repo');
  });

  it('accepts the other allowlisted hosts', () => {
    for (const url of [
      'https://gitlab.com/owner/repo.git',
      'https://bitbucket.org/owner/repo.git',
      'https://gist.githubusercontent.com/owner/abc/raw',
    ]) {
      expect('error' in validateIndexRepoUrl(url)).toBe(false);
    }
  });

  it('accepts a URL with a trailing slash', () => {
    const result = validateIndexRepoUrl('https://github.com/owner/repo/');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.hint).toBe('https://github.com/owner/repo');
  });
});

describe('validateIndexRepoUrl — rejected', () => {
  it('rejects non-https schemes', () => {
    const cases = [
      'http://github.com/owner/repo.git',
      'git://github.com/owner/repo.git',
      'ssh://git@github.com/owner/repo.git',
      'file:///etc/passwd',
      'data:text/plain,hello',
    ];
    for (const url of cases) {
      expect(errorFor(url)).toMatch(/https|scheme|valid/i);
    }
  });

  it('rejects hosts outside the allowlist', () => {
    expect(errorFor('https://evil.example/repo.git')).toMatch(/not accepted/i);
    expect(errorFor('https://gitlab.com.evil.example/repo.git')).toMatch(/not accepted/i);
  });

  it('rejects SSRF targets even when they use https', () => {
    expect(errorFor('https://169.254.169.254/latest/meta-data')).toMatch(/not accepted/i);
    expect(errorFor('https://127.0.0.1:6379/')).toMatch(/not accepted/i);
    expect(errorFor('https://localhost/repo.git')).toMatch(/not accepted/i);
  });

  it('rejects embedded credentials', () => {
    expect(errorFor('https://x-access-token:ghp_secret@github.com/owner/repo.git')).toMatch(
      /credentials/i
    );
  });

  it('rejects shell metacharacters in the path or query', () => {
    for (const url of [
      'https://github.com/owner/repo;rm -rf /',
      'https://github.com/owner/repo$(id)',
      'https://github.com/owner/repo`whoami`',
      'https://github.com/owner/repo?branch=main&x=$(id)',
    ]) {
      expect(errorFor(url)).toMatch(/not allowed/i);
    }
  });

  it('rejects empty and malformed input', () => {
    expect(errorFor('')).toMatch(/non-empty/i);
    expect(errorFor('not-a-url')).toMatch(/valid URL/i);
  });
});

describe('isPrivateIpv4', () => {
  it.each([
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '127.0.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
  ])('treats %s as private', (ip) => {
    expect(isPrivateIpv4(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '140.82.112.3'])(
    'treats %s as public',
    (ip) => {
      expect(isPrivateIpv4(ip)).toBe(false);
    }
  );

  it('rejects malformed addresses', () => {
    expect(isPrivateIpv4('10.0.0')).toBe(false);
    expect(isPrivateIpv4('10.0.0.256')).toBe(false);
  });
});

describe('isPrivateIpv6', () => {
  it.each(['::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1'])(
    'treats %s as private',
    (ip) => {
      expect(isPrivateIpv6(ip)).toBe(true);
    }
  );

  it('treats a public address as public', () => {
    expect(isPrivateIpv6('2606:4700:4700::1111')).toBe(false);
  });
});

describe('hasForbiddenUrlChars', () => {
  it('flags shell metacharacters and whitespace', () => {
    for (const ch of [';', '|', '&', '`', '$', '(', ')', '\\', '\n', ' ']) {
      expect(hasForbiddenUrlChars(`abc${ch}def`)).toBe(true);
    }
  });

  it('allows ordinary repository path characters', () => {
    expect(hasForbiddenUrlChars('/owner/my-repo.name_1.git')).toBe(false);
  });
});
