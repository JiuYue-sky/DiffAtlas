import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PathGuardError } from './types.js';

/**
 * Strip Windows extended-length prefix (`\\?\` or `\\?\UNC\`) for uniform comparison
 * while still allowing Node's fs layer to handle >260 char paths transparently.
 */
export function stripWindowsLongPathPrefix(rawPath: string): string {
  if (rawPath.startsWith('\\\\?\\UNC\\')) {
    return '\\\\' + rawPath.slice('\\\\?\\UNC\\'.length);
  }
  if (rawPath.startsWith('\\\\?\\')) {
    return rawPath.slice('\\\\?\\'.length);
  }
  return rawPath;
}

/**
 * Normalize path separators to POSIX forward slashes for cross-platform stable keys/UI display.
 * On macOS (`darwin`) and Windows (`win32`), also normalizes Unicode to NFC so macOS APFS/HFS+
 * decomposed NFD filenames (e.g. `café.ts`, `が.py`) match NFC UTF-8 import specifiers, while preserving
 * byte-exact filenames on Linux (`ext4`/`xfs`).
 */
export function toPosixPath(inputPath: string): string {
  const slashed = stripWindowsLongPathPrefix(inputPath).replace(/\\/g, '/');
  return process.platform === 'darwin' || process.platform === 'win32' ? slashed.normalize('NFC') : slashed;
}

/**
 * Convert an absolute local filesystem path into a standards-compliant RFC 8089 `file://` URI
 * accepted by `com.google.antigravity/toggle-aux-pane` (`fileView`) across Windows (drive & UNC), macOS, and Linux.
 */
export function toFileUri(absPath: string): string {
  const clean = stripWindowsLongPathPrefix(path.resolve(absPath));
  return pathToFileURL(clean).href;
}

/**
 * Safely converts a `file://` URI (e.g. from MCP `roots/list`) into a local filesystem path.
 */
export function fromFileUri(uri: string): string | null {
  try {
    if (!uri.toLowerCase().startsWith('file://')) return null;
    return stripWindowsLongPathPrefix(fileURLToPath(uri));
  } catch {
    return null;
  }
}

const DEFAULT_SENSITIVE_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..+)?$/i,
  /\.(pem|key|pfx|p12|kdbx|keystore|jks|der|crt)$/i,
  /^\.(npmrc|pypirc|netrc|dockerconfigjson|git-credentials|htpasswd)$/i,
  /^_netrc$/i,
  /(?:^|[_.-])(?:credentials|secrets?|service[-_]?account)(?:[_.-].*)?\.(?:json|ya?ml|toml|ini)$/i,
];

const DEFAULT_SENSITIVE_SEGMENT_PATTERNS: readonly RegExp[] = [
  /^\.ssh$/i,
  /^\.aws$/i,
  /^\.gnupg$/i,
  /^\.kube$/i,
  /^\.azure$/i,
  /^\.gcloud$/i,
];

const SECRET_REDACTION_PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_PAT]'],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]'],
  [/\bAIza[0-9A-Za-z\-_]{30,}\b/g, '[REDACTED_GOOGLE_KEY]'],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/(https?:\/\/[^/\s:@]+:)([^@\s/]+)(@)/gi, '$1[REDACTED_AUTH]$3'],
  [/\b0x[0-9a-fA-F]{64}\b/g, '[REDACTED_HEX_KEY]'],
];

const EXTERNAL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export interface ResolvedSafePath {
  /** Canonical workspace root (`fs.realpathSync.native`) */
  workspaceRoot: string;
  /** Canonical absolute target path inside workspaceRoot */
  absolutePath: string;
  /** Workspace-relative POSIX path (e.g. `src/kit/path-guard.ts`, or `""` for root itself) */
  relativePath: string;
  /** Whether the target existed on disk at validation time */
  exists: boolean;
}

export interface PathGuardOptions {
  /** Allow reading sensitive files? Default: false (strictly blocked) */
  allowSensitive?: boolean;
}

function assertNoControlOrNul(raw: string): void {
  if (!raw || raw.trim().length === 0) {
    throw new PathGuardError('ERR_EMPTY_PATH', 'Path must not be empty.', raw);
  }
  if (raw.includes('\0')) {
    throw new PathGuardError('ERR_NUL_BYTE', 'Path contains illegal NUL byte.', '[NUL_REDACTED]');
  }
  // Disallow ASCII control characters (0x01-0x1F)
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code >= 1 && code <= 0x1f) {
      throw new PathGuardError('ERR_CONTROL_CHAR', 'Path contains illegal control characters.', '[CTRL_REDACTED]');
    }
  }
}

function canonicalRealpath(targetPath: string): string {
  // Preserve exact OS kernel path bytes so Linux byte-exact non-NFC filenames never fail `fs.openSync`
  const real = fs.realpathSync.native(targetPath);
  return stripWindowsLongPathPrefix(real);
}

function normalizeForContainment(p: string): string {
  if (process.platform === 'win32') return p.normalize('NFC').toLowerCase();
  if (process.platform === 'darwin') return p.normalize('NFC');
  return p;
}

function isWithinCanonicalRoot(realRoot: string, candidateAbs: string): boolean {
  const normRoot = normalizeForContainment(realRoot);
  const normCandidate = normalizeForContainment(candidateAbs);
  const rel = path.relative(normRoot, normCandidate);
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith('../') || path.isAbsolute(rel)) {
    return false;
  }
  return true;
}

const WINDOWS_RESERVED_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function hasWindowsReservedDeviceSegment(posixRelOrAbs: string): boolean {
  const parts = posixRelOrAbs.split('/').filter(Boolean);
  for (const seg of parts) {
    if (/^[A-Za-z]:$/.test(seg)) continue;
    const trimmed = seg.replace(/[. ]+$/, '');
    if (WINDOWS_RESERVED_DEVICE_RE.test(trimmed)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if a workspace-relative or absolute path matches the sensitive-file denylist
 * (entire `.git/**` internals, `.env*`, private keys, `.ssh/*`, cloud credentials, etc.).
 */
export function isSensitivePath(relativeOrAbsPath: string): boolean {
  const posix = toPosixPath(relativeOrAbsPath);
  const parts = posix.split('/').filter(Boolean);
  if (parts.length === 0) return false;

  // Block the ENTIRE `.git/` internal directory (`.git/hooks/*`, `.git/config`, `.git/index`, `.git/HEAD`, etc.)
  // to prevent reading tokens, snapshotting git internals, or corrupting repository metadata.
  if (parts.some((seg) => seg.toLowerCase() === '.git')) {
    return true;
  }

  for (const seg of parts.slice(0, -1)) {
    if (DEFAULT_SENSITIVE_SEGMENT_PATTERNS.some((re) => re.test(seg))) {
      return true;
    }
  }

  const base = parts[parts.length - 1] ?? '';
  return DEFAULT_SENSITIVE_BASENAME_PATTERNS.some((re) => re.test(base));
}

/**
 * Hardened workspace sandbox guard for DiffAtlas and reusable companion Antigravity MCP App plugins.
 * Enforces `fs.realpathSync.native` canonical containment, symlink escape detection,
 * Windows casing/long-path normalization, NUL-byte blocking, and sensitive file denylist.
 */
export class PathGuard {
  public readonly workspaceRoot: string;

  constructor(workspaceRootInput: string) {
    assertNoControlOrNul(workspaceRootInput);
    const resolvedInput = stripWindowsLongPathPrefix(path.resolve(workspaceRootInput));
    if (!fs.existsSync(resolvedInput) || !fs.statSync(resolvedInput).isDirectory()) {
      throw new PathGuardError(
        'ERR_WORKSPACE_NOT_FOUND',
        `Workspace directory does not exist: ${redactPersonalPaths(workspaceRootInput)}`,
        workspaceRootInput,
      );
    }
    this.workspaceRoot = canonicalRealpath(resolvedInput);
  }

  /**
   * Resolves a user/model-supplied relative or absolute path strictly inside `workspaceRoot`.
   * Handles both existing targets and not-yet-created targets (walking to nearest existing ancestor
   * and verifying every intermediate segment against symlink escape).
   */
  public resolvePath(targetInput: string, options: PathGuardOptions = {}): ResolvedSafePath {
    assertNoControlOrNul(targetInput);
    const rawTrimmed = stripWindowsLongPathPrefix(targetInput.trim());
    const cleanedInput =
      process.platform === 'darwin' || process.platform === 'win32' ? rawTrimmed.normalize('NFC') : rawTrimmed;
    if (hasWindowsReservedDeviceSegment(toPosixPath(cleanedInput))) {
      throw new PathGuardError(
        'ERR_CONTROL_CHAR',
        'Windows reserved device name (CON/PRN/AUX/NUL/COM/LPT) is blocked by PathGuard.',
        targetInput,
      );
    }

    // Reject external network/protocol URIs passed where filesystem paths are expected
    // (Allow Windows drive letters like `C:\...` or `D:/...`)
    if (EXTERNAL_SCHEME_RE.test(cleanedInput) && !/^[A-Za-z]:[/\\]/.test(cleanedInput)) {
      if (cleanedInput.toLowerCase().startsWith('file://')) {
        throw new PathGuardError(
          'ERR_EXTERNAL_URI_BLOCKED',
          'Pass workspace paths rather than raw file:// URIs.',
          targetInput,
        );
      }
      throw new PathGuardError(
        'ERR_EXTERNAL_URI_BLOCKED',
        `External URI scheme is blocked by PathGuard: ${cleanedInput.slice(0, 24)}`,
        targetInput,
      );
    }

    const candidateLexical = path.isAbsolute(cleanedInput)
      ? path.resolve(cleanedInput)
      : path.resolve(this.workspaceRoot, cleanedInput);

    let exists = false;
    try {
      fs.lstatSync(candidateLexical);
      exists = true;
    } catch {
      exists = false;
    }

    let canonicalTarget: string;

    if (exists) {
      try {
        canonicalTarget = canonicalRealpath(candidateLexical);
      } catch {
        // Broken symlink: check lstat parent + reject broken symlink pointing outside
        const lstat = fs.lstatSync(candidateLexical);
        if (lstat.isSymbolicLink()) {
          throw new PathGuardError(
            'ERR_SYMLINK_ESCAPE',
            'Broken or unresolvable symbolic link is blocked by PathGuard.',
            targetInput,
          );
        }
        throw new PathGuardError('ERR_OUTSIDE_WORKSPACE', 'Unable to canonicalize path.', targetInput);
      }

      if (!isWithinCanonicalRoot(this.workspaceRoot, canonicalTarget)) {
        // Distinguish lexical traversal vs symlink escape for clear security diagnostics
        const lexicalInside = isWithinCanonicalRoot(this.workspaceRoot, candidateLexical);
        throw new PathGuardError(
          lexicalInside ? 'ERR_SYMLINK_ESCAPE' : 'ERR_OUTSIDE_WORKSPACE',
          lexicalInside
            ? 'Symbolic link or junction escapes the workspace root.'
            : 'Requested path resolves outside the workspace root.',
          targetInput,
        );
      }
    } else {
      // Target does not exist yet (e.g., PreToolUse before write_file creates a new file).
      // Walk up to the deepest existing ancestor, canonicalize it, and ensure containment.
      const pendingSegments: string[] = [];
      let cursor = candidateLexical;
      while (!fs.existsSync(cursor)) {
        const parent = path.dirname(cursor);
        if (parent === cursor) {
          throw new PathGuardError('ERR_OUTSIDE_WORKSPACE', 'No existing ancestor directory found.', targetInput);
        }
        // Check if cursor itself is a dangling symlink (`existsSync` returns false for dangling symlinks!)
        try {
          const st = fs.lstatSync(cursor);
          if (st.isSymbolicLink()) {
            throw new PathGuardError(
              'ERR_SYMLINK_ESCAPE',
              'Dangling symbolic link along path is blocked by PathGuard.',
              targetInput,
            );
          }
        } catch (err) {
          if (err instanceof PathGuardError) throw err;
        }
        pendingSegments.unshift(path.basename(cursor));
        cursor = parent;
      }

      const canonicalAncestor = canonicalRealpath(cursor);
      if (!isWithinCanonicalRoot(this.workspaceRoot, canonicalAncestor)) {
        const lexicalInside = isWithinCanonicalRoot(this.workspaceRoot, cursor);
        throw new PathGuardError(
          lexicalInside ? 'ERR_SYMLINK_ESCAPE' : 'ERR_OUTSIDE_WORKSPACE',
          lexicalInside
            ? 'Ancestor symbolic link escapes the workspace root.'
            : 'Target ancestor resolves outside the workspace root.',
          targetInput,
        );
      }
      canonicalTarget = path.join(canonicalAncestor, ...pendingSegments);
      if (!isWithinCanonicalRoot(this.workspaceRoot, canonicalTarget)) {
        throw new PathGuardError('ERR_OUTSIDE_WORKSPACE', 'Resolved target escapes workspace root.', targetInput);
      }
    }

    const relativePosix = toPosixPath(path.relative(this.workspaceRoot, canonicalTarget));
    if (!options.allowSensitive && isSensitivePath(relativePosix)) {
      throw new PathGuardError(
        'ERR_SENSITIVE_FILE_BLOCKED',
        `Access to sensitive file "${relativePosix}" is blocked by PathGuard policy.`,
        targetInput,
      );
    }

    return {
      workspaceRoot: this.workspaceRoot,
      absolutePath: canonicalTarget,
      relativePath: relativePosix,
      exists,
    };
  }

  /**
   * Validates subresource URIs (e.g., `.gltf` external buffer/texture URIs in companion 3D/asset plugins).
   * Allows inline `data:application/octet-stream;base64,...` or `data:image/...;base64,...`,
   * blocks `http(s)://`, `ws(s)://`, `ftp://`, `javascript:`, and resolves relative file URIs
   * strictly inside `workspaceRoot`.
   */
  public validateSubresourceUri(
    uri: string,
    containingDirAbs: string = this.workspaceRoot,
  ): { kind: 'data-uri' } | { kind: 'local-file'; resolved: ResolvedSafePath } {
    assertNoControlOrNul(uri);
    const trimmed = uri.trim();
    if (/^data:(?:application\/octet-stream|application\/gltf-buffer|image\/(?:png|jpeg|webp|ktx2))(?:;[^,]*)?,/i.test(trimmed)) {
      return { kind: 'data-uri' };
    }
    if (EXTERNAL_SCHEME_RE.test(trimmed)) {
      throw new PathGuardError(
        'ERR_EXTERNAL_URI_BLOCKED',
        `External or unsafe subresource URI is blocked (SSRF protection): ${trimmed.slice(0, 32)}`,
        uri,
      );
    }
    let decoded = trimmed;
    try {
      decoded = decodeURIComponent(trimmed);
    } catch {
      // Literal unencoded '%' in local filename (e.g. `100%_roughness.png`) — keep literal string
      decoded = trimmed;
    }
    const combined = path.resolve(containingDirAbs, decoded);
    return {
      kind: 'local-file',
      resolved: this.resolvePath(combined),
    };
  }
}

/**
 * Redacts personal home directory paths (`C:\Users\<name>`, `/Users/<name>`, `/home/<name>`)
 * from diagnostic strings.
 */
export function redactPersonalPaths(text: string): string {
  if (!text) return text;
  const home = os.homedir();
  let result = text;
  if (home && home.length > 3) {
    const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedPosixHome = home.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escapedHome, 'gi'), '~');
    result = result.replace(new RegExp(escapedPosixHome, 'gi'), '~');
  }
  result = result
    .replace(/[A-Za-z]:[/\\]{1,2}Users[/\\]{1,2}(?!<|public\b|default\b)[^/\\\s"'<>|*?]+/gi, '<USER_HOME>')
    .replace(/\/Users\/(?!<|Shared\b)[^/\s"'<>|*?]+/g, '<USER_HOME>')
    .replace(/\/home\/(?!<)[^/\s"'<>|*?]+/g, '<USER_HOME>');
  return result;
}

/**
 * Scrubs secret tokens, private keys, basic-auth URLs, and personal paths from text
 * destined for logs or LLM `CallToolResult.content`.
 */
export function redactSecretsAndPaths(text: string, options: { redactPaths?: boolean } = {}): string {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of SECRET_REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  if (options.redactPaths !== false) {
    out = redactPersonalPaths(out);
  }
  return out;
}

/**
 * Sanitizes untrusted repository tokens (import specifiers, filenames) before embedding
 * into model-visible Markdown to mitigate indirect prompt injection.
 */
export function sanitizeUntrustedIdentifier(raw: string, maxLen = 180): string {
  const stripped = raw
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    .replace(/`/g, "'")
    .replace(/\r?\n/g, ' ')
    .trim();
  return stripped.length > maxLen ? `${stripped.slice(0, maxLen)}...` : stripped;
}
