"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/hooks/lifecycle-hook.ts
var import_node_path4 = __toESM(require("node:path"), 1);

// src/kit/path-guard.ts
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_os = __toESM(require("node:os"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var import_node_url = require("node:url");

// src/kit/types.ts
var PathGuardError = class extends Error {
  code;
  requestedPath;
  constructor(code, message, requestedPath) {
    super(message);
    this.name = "PathGuardError";
    this.code = code;
    this.requestedPath = requestedPath;
  }
};

// src/kit/path-guard.ts
function stripWindowsLongPathPrefix(rawPath) {
  if (rawPath.startsWith("\\\\?\\UNC\\")) {
    return "\\\\" + rawPath.slice("\\\\?\\UNC\\".length);
  }
  if (rawPath.startsWith("\\\\?\\")) {
    return rawPath.slice("\\\\?\\".length);
  }
  return rawPath;
}
function toPosixPath(inputPath) {
  const slashed = stripWindowsLongPathPrefix(inputPath).replace(/\\/g, "/");
  return process.platform === "darwin" || process.platform === "win32" ? slashed.normalize("NFC") : slashed;
}
function fromFileUri(uri) {
  try {
    if (!uri.toLowerCase().startsWith("file://")) return null;
    return stripWindowsLongPathPrefix((0, import_node_url.fileURLToPath)(uri));
  } catch {
    return null;
  }
}
var DEFAULT_SENSITIVE_BASENAME_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..+)?$/i,
  /\.(pem|key|pfx|p12|kdbx|keystore|jks|der|crt)$/i,
  /^\.(npmrc|pypirc|netrc|dockerconfigjson|git-credentials|htpasswd)$/i,
  /^_netrc$/i,
  /(?:^|[_.-])(?:credentials|secrets?|service[-_]?account)(?:[_.-].*)?\.(?:json|ya?ml|toml|ini)$/i
];
var DEFAULT_SENSITIVE_SEGMENT_PATTERNS = [
  /^\.ssh$/i,
  /^\.aws$/i,
  /^\.gnupg$/i,
  /^\.kube$/i,
  /^\.azure$/i,
  /^\.gcloud$/i
];
var SECRET_REDACTION_PATTERNS = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_PAT]"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_API_KEY]"],
  [/\bAIza[0-9A-Za-z\-_]{30,}\b/g, "[REDACTED_GOOGLE_KEY]"],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/(https?:\/\/[^/\s:@]+:)([^@\s/]+)(@)/gi, "$1[REDACTED_AUTH]$3"],
  [/\b0x[0-9a-fA-F]{64}\b/g, "[REDACTED_HEX_KEY]"]
];
var EXTERNAL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
function assertNoControlOrNul(raw) {
  if (!raw || raw.trim().length === 0) {
    throw new PathGuardError("ERR_EMPTY_PATH", "Path must not be empty.", raw);
  }
  if (raw.includes("\0")) {
    throw new PathGuardError("ERR_NUL_BYTE", "Path contains illegal NUL byte.", "[NUL_REDACTED]");
  }
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code >= 1 && code <= 31) {
      throw new PathGuardError("ERR_CONTROL_CHAR", "Path contains illegal control characters.", "[CTRL_REDACTED]");
    }
  }
}
function canonicalRealpath(targetPath) {
  const real = import_node_fs.default.realpathSync.native(targetPath);
  return stripWindowsLongPathPrefix(real);
}
function normalizeForContainment(p) {
  if (process.platform === "win32") return p.normalize("NFC").toLowerCase();
  if (process.platform === "darwin") return p.normalize("NFC");
  return p;
}
function isWithinCanonicalRoot(realRoot, candidateAbs) {
  const normRoot = normalizeForContainment(realRoot);
  const normCandidate = normalizeForContainment(candidateAbs);
  const rel = import_node_path.default.relative(normRoot, normCandidate);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${import_node_path.default.sep}`) || rel.startsWith("../") || import_node_path.default.isAbsolute(rel)) {
    return false;
  }
  return true;
}
var WINDOWS_RESERVED_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function hasWindowsReservedDeviceSegment(posixRelOrAbs) {
  const parts = posixRelOrAbs.split("/").filter(Boolean);
  for (const seg of parts) {
    if (/^[A-Za-z]:$/.test(seg)) continue;
    const trimmed = seg.replace(/[. ]+$/, "");
    if (WINDOWS_RESERVED_DEVICE_RE.test(trimmed)) {
      return true;
    }
  }
  return false;
}
function isSensitivePath(relativeOrAbsPath) {
  const posix = toPosixPath(relativeOrAbsPath);
  const parts = posix.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.some((seg) => seg.toLowerCase() === ".git")) {
    return true;
  }
  for (const seg of parts.slice(0, -1)) {
    if (DEFAULT_SENSITIVE_SEGMENT_PATTERNS.some((re) => re.test(seg))) {
      return true;
    }
  }
  const base = parts[parts.length - 1] ?? "";
  return DEFAULT_SENSITIVE_BASENAME_PATTERNS.some((re) => re.test(base));
}
var PathGuard = class {
  workspaceRoot;
  constructor(workspaceRootInput) {
    assertNoControlOrNul(workspaceRootInput);
    const resolvedInput = stripWindowsLongPathPrefix(import_node_path.default.resolve(workspaceRootInput));
    if (!import_node_fs.default.existsSync(resolvedInput) || !import_node_fs.default.statSync(resolvedInput).isDirectory()) {
      throw new PathGuardError(
        "ERR_WORKSPACE_NOT_FOUND",
        `Workspace directory does not exist: ${redactPersonalPaths(workspaceRootInput)}`,
        workspaceRootInput
      );
    }
    this.workspaceRoot = canonicalRealpath(resolvedInput);
  }
  /**
   * Resolves a user/model-supplied relative or absolute path strictly inside `workspaceRoot`.
   * Handles both existing targets and not-yet-created targets (walking to nearest existing ancestor
   * and verifying every intermediate segment against symlink escape).
   */
  resolvePath(targetInput, options = {}) {
    assertNoControlOrNul(targetInput);
    const rawTrimmed = stripWindowsLongPathPrefix(targetInput.trim());
    const cleanedInput = process.platform === "darwin" || process.platform === "win32" ? rawTrimmed.normalize("NFC") : rawTrimmed;
    if (hasWindowsReservedDeviceSegment(toPosixPath(cleanedInput))) {
      throw new PathGuardError(
        "ERR_CONTROL_CHAR",
        "Windows reserved device name (CON/PRN/AUX/NUL/COM/LPT) is blocked by PathGuard.",
        targetInput
      );
    }
    if (EXTERNAL_SCHEME_RE.test(cleanedInput) && !/^[A-Za-z]:[/\\]/.test(cleanedInput)) {
      if (cleanedInput.toLowerCase().startsWith("file://")) {
        throw new PathGuardError(
          "ERR_EXTERNAL_URI_BLOCKED",
          "Pass workspace paths rather than raw file:// URIs.",
          targetInput
        );
      }
      throw new PathGuardError(
        "ERR_EXTERNAL_URI_BLOCKED",
        `External URI scheme is blocked by PathGuard: ${cleanedInput.slice(0, 24)}`,
        targetInput
      );
    }
    const candidateLexical = import_node_path.default.isAbsolute(cleanedInput) ? import_node_path.default.resolve(cleanedInput) : import_node_path.default.resolve(this.workspaceRoot, cleanedInput);
    let exists = false;
    try {
      import_node_fs.default.lstatSync(candidateLexical);
      exists = true;
    } catch {
      exists = false;
    }
    let canonicalTarget;
    if (exists) {
      try {
        canonicalTarget = canonicalRealpath(candidateLexical);
      } catch {
        const lstat = import_node_fs.default.lstatSync(candidateLexical);
        if (lstat.isSymbolicLink()) {
          throw new PathGuardError(
            "ERR_SYMLINK_ESCAPE",
            "Broken or unresolvable symbolic link is blocked by PathGuard.",
            targetInput
          );
        }
        throw new PathGuardError("ERR_OUTSIDE_WORKSPACE", "Unable to canonicalize path.", targetInput);
      }
      if (!isWithinCanonicalRoot(this.workspaceRoot, canonicalTarget)) {
        const lexicalInside = isWithinCanonicalRoot(this.workspaceRoot, candidateLexical);
        throw new PathGuardError(
          lexicalInside ? "ERR_SYMLINK_ESCAPE" : "ERR_OUTSIDE_WORKSPACE",
          lexicalInside ? "Symbolic link or junction escapes the workspace root." : "Requested path resolves outside the workspace root.",
          targetInput
        );
      }
    } else {
      const pendingSegments = [];
      let cursor = candidateLexical;
      while (!import_node_fs.default.existsSync(cursor)) {
        const parent = import_node_path.default.dirname(cursor);
        if (parent === cursor) {
          throw new PathGuardError("ERR_OUTSIDE_WORKSPACE", "No existing ancestor directory found.", targetInput);
        }
        try {
          const st = import_node_fs.default.lstatSync(cursor);
          if (st.isSymbolicLink()) {
            throw new PathGuardError(
              "ERR_SYMLINK_ESCAPE",
              "Dangling symbolic link along path is blocked by PathGuard.",
              targetInput
            );
          }
        } catch (err) {
          if (err instanceof PathGuardError) throw err;
        }
        pendingSegments.unshift(import_node_path.default.basename(cursor));
        cursor = parent;
      }
      const canonicalAncestor = canonicalRealpath(cursor);
      if (!isWithinCanonicalRoot(this.workspaceRoot, canonicalAncestor)) {
        const lexicalInside = isWithinCanonicalRoot(this.workspaceRoot, cursor);
        throw new PathGuardError(
          lexicalInside ? "ERR_SYMLINK_ESCAPE" : "ERR_OUTSIDE_WORKSPACE",
          lexicalInside ? "Ancestor symbolic link escapes the workspace root." : "Target ancestor resolves outside the workspace root.",
          targetInput
        );
      }
      canonicalTarget = import_node_path.default.join(canonicalAncestor, ...pendingSegments);
      if (!isWithinCanonicalRoot(this.workspaceRoot, canonicalTarget)) {
        throw new PathGuardError("ERR_OUTSIDE_WORKSPACE", "Resolved target escapes workspace root.", targetInput);
      }
    }
    const relativePosix = toPosixPath(import_node_path.default.relative(this.workspaceRoot, canonicalTarget));
    if (!options.allowSensitive && isSensitivePath(relativePosix)) {
      throw new PathGuardError(
        "ERR_SENSITIVE_FILE_BLOCKED",
        `Access to sensitive file "${relativePosix}" is blocked by PathGuard policy.`,
        targetInput
      );
    }
    return {
      workspaceRoot: this.workspaceRoot,
      absolutePath: canonicalTarget,
      relativePath: relativePosix,
      exists
    };
  }
  /**
   * Validates subresource URIs (e.g., `.gltf` external buffer/texture URIs in companion 3D/asset plugins).
   * Allows inline `data:application/octet-stream;base64,...` or `data:image/...;base64,...`,
   * blocks `http(s)://`, `ws(s)://`, `ftp://`, `javascript:`, and resolves relative file URIs
   * strictly inside `workspaceRoot`.
   */
  validateSubresourceUri(uri, containingDirAbs = this.workspaceRoot) {
    assertNoControlOrNul(uri);
    const trimmed = uri.trim();
    if (/^data:(?:application\/octet-stream|application\/gltf-buffer|image\/(?:png|jpeg|webp|ktx2))(?:;[^,]*)?,/i.test(trimmed)) {
      return { kind: "data-uri" };
    }
    if (EXTERNAL_SCHEME_RE.test(trimmed)) {
      throw new PathGuardError(
        "ERR_EXTERNAL_URI_BLOCKED",
        `External or unsafe subresource URI is blocked (SSRF protection): ${trimmed.slice(0, 32)}`,
        uri
      );
    }
    let decoded = trimmed;
    try {
      decoded = decodeURIComponent(trimmed);
    } catch {
      decoded = trimmed;
    }
    const combined = import_node_path.default.resolve(containingDirAbs, decoded);
    return {
      kind: "local-file",
      resolved: this.resolvePath(combined)
    };
  }
};
function redactPersonalPaths(text) {
  if (!text) return text;
  const home = import_node_os.default.homedir();
  let result = text;
  if (home && home.length > 3) {
    const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedPosixHome = home.replace(/\\/g, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escapedHome, "gi"), "~");
    result = result.replace(new RegExp(escapedPosixHome, "gi"), "~");
  }
  result = result.replace(/[A-Za-z]:[/\\]{1,2}Users[/\\]{1,2}(?!<|public\b|default\b)[^/\\\s"'<>|*?]+/gi, "<USER_HOME>").replace(/\/Users\/(?!<|Shared\b)[^/\s"'<>|*?]+/g, "<USER_HOME>").replace(/\/home\/(?!<)[^/\s"'<>|*?]+/g, "<USER_HOME>");
  return result;
}
function redactSecretsAndPaths(text, options = {}) {
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
function sanitizeUntrustedIdentifier(raw, maxLen = 180) {
  const stripped = raw.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF]/g, "").replace(/`/g, "'").replace(/\r?\n/g, " ").trim();
  return stripped.length > maxLen ? `${stripped.slice(0, maxLen)}...` : stripped;
}

// src/kit/process-guard.ts
function installHookFailOpenWatchdog(timeoutMs, onTrip) {
  const timer = setTimeout(() => {
    onTrip();
  }, timeoutMs);
  timer.unref();
  return () => clearTimeout(timer);
}

// src/kit/runtime-paths.ts
var import_node_crypto = __toESM(require("node:crypto"), 1);
var import_node_fs2 = __toESM(require("node:fs"), 1);
var import_node_os2 = __toESM(require("node:os"), 1);
var import_node_path2 = __toESM(require("node:path"), 1);
function isUnexpandedTemplateVar(val) {
  if (!val) return true;
  const trimmed = val.trim();
  return trimmed.length === 0 || trimmed.includes("${PLUGIN_");
}
function resolvePluginRuntimePaths(identity, argv = process.argv.slice(2), env = process.env, fallbackRoot = process.cwd()) {
  let cliPluginRoot;
  let cliDataDir;
  for (const arg of argv) {
    if (arg.startsWith("--plugin-root=")) {
      cliPluginRoot = arg.slice("--plugin-root=".length);
    } else if (arg.startsWith("--data-dir=")) {
      cliDataDir = arg.slice("--data-dir=".length);
    }
  }
  const rawPluginRoot = !isUnexpandedTemplateVar(cliPluginRoot) ? cliPluginRoot : !isUnexpandedTemplateVar(env.PLUGIN_ROOT) ? env.PLUGIN_ROOT : fallbackRoot;
  const pluginRoot = stripWindowsLongPathPrefix(import_node_path2.default.resolve(rawPluginRoot));
  const rawDataDir = !isUnexpandedTemplateVar(cliDataDir) ? cliDataDir : !isUnexpandedTemplateVar(env.PLUGIN_DATA) ? env.PLUGIN_DATA : import_node_path2.default.join(import_node_os2.default.homedir(), ".gemini", "antigravity-plugin-data", identity.id);
  const dataDir = stripWindowsLongPathPrefix(import_node_path2.default.resolve(rawDataDir));
  const stateDir = import_node_path2.default.join(dataDir, "state");
  const auditLogPath = import_node_path2.default.join(dataDir, "audit.jsonl");
  const envHtmlOverride = env[identity.appHtmlEnvVar];
  const defaultAppHtmlPath = envHtmlOverride && envHtmlOverride.trim().length > 0 ? stripWindowsLongPathPrefix(import_node_path2.default.resolve(envHtmlOverride.trim())) : import_node_path2.default.join(pluginRoot, "dist", "ui", "app.html");
  import_node_fs2.default.mkdirSync(stateDir, { recursive: true });
  return {
    pluginRoot,
    dataDir,
    stateDir,
    auditLogPath,
    defaultAppHtmlPath
  };
}
function atomicWriteFileSync(targetPath, content, mode) {
  const dir = import_node_path2.default.dirname(targetPath);
  import_node_fs2.default.mkdirSync(dir, { recursive: true });
  const tmpPath = import_node_path2.default.join(
    dir,
    `.${import_node_path2.default.basename(targetPath)}.${process.pid}.${import_node_crypto.default.randomBytes(4).toString("hex")}.tmp`
  );
  import_node_fs2.default.writeFileSync(tmpPath, content, mode !== void 0 && process.platform !== "win32" ? { mode } : void 0);
  if (mode !== void 0 && process.platform !== "win32") {
    try {
      import_node_fs2.default.chmodSync(tmpPath, mode);
    } catch {
    }
  }
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      import_node_fs2.default.renameSync(tmpPath, targetPath);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt === 4) {
        try {
          import_node_fs2.default.copyFileSync(tmpPath, targetPath);
          if (mode !== void 0 && process.platform !== "win32") {
            try {
              import_node_fs2.default.chmodSync(targetPath, mode);
            } catch {
            }
          }
          import_node_fs2.default.unlinkSync(tmpPath);
          return;
        } catch {
        }
      } else {
        try {
          const sab = new SharedArrayBuffer(4);
          Atomics.wait(new Int32Array(sab), 0, 0, 8 * (attempt + 1));
        } catch {
        }
      }
    }
  }
  try {
    if (import_node_fs2.default.existsSync(tmpPath)) import_node_fs2.default.unlinkSync(tmpPath);
  } catch {
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
var MAX_AUDIT_LOG_BYTES = 5 * 1024 * 1024;
function appendAuditLogSync(auditLogPath, entry, maxBytes = MAX_AUDIT_LOG_BYTES) {
  try {
    import_node_fs2.default.mkdirSync(import_node_path2.default.dirname(auditLogPath), { recursive: true });
    try {
      if (import_node_fs2.default.existsSync(auditLogPath) && import_node_fs2.default.statSync(auditLogPath).size >= maxBytes) {
        const rotatedPath = `${auditLogPath}.1`;
        try {
          if (import_node_fs2.default.existsSync(rotatedPath)) import_node_fs2.default.unlinkSync(rotatedPath);
        } catch {
        }
        import_node_fs2.default.renameSync(auditLogPath, rotatedPath);
      }
    } catch {
    }
    const fullRecord = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      ...entry
    };
    const serialized = redactSecretsAndPaths(JSON.stringify(fullRecord));
    import_node_fs2.default.appendFileSync(auditLogPath, `${serialized}
`, "utf8");
  } catch {
  }
}
function computeWorkspaceId(canonicalWorkspaceRoot) {
  const normalized = process.platform === "win32" ? toPosixPath(canonicalWorkspaceRoot).toLowerCase() : toPosixPath(canonicalWorkspaceRoot);
  return import_node_crypto.default.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
var PluginStateStore = class {
  recentFilePath;
  preferencesFilePath;
  constructor(stateDir) {
    import_node_fs2.default.mkdirSync(stateDir, { recursive: true });
    this.recentFilePath = import_node_path2.default.join(stateDir, "recent-targets.json");
    this.preferencesFilePath = import_node_path2.default.join(stateDir, "preferences.json");
  }
  recordRecentTarget(targetPath, kind, maxItems = 12) {
    const clean = stripWindowsLongPathPrefix(import_node_path2.default.resolve(targetPath));
    const posix = toPosixPath(clean);
    const current = this.getRecentTargets();
    if (kind === "workspace" && /(?:^|\/)(?:\.agents?|_agents?)\/plugins(?:\/|$)/i.test(posix)) {
      return current;
    }
    const label = import_node_path2.default.basename(clean) || posix;
    const normKey = process.platform === "win32" ? posix.toLowerCase() : posix;
    const top = current[0];
    if (top && top.kind === kind) {
      const topKey = process.platform === "win32" ? toPosixPath(top.path).toLowerCase() : toPosixPath(top.path);
      const ageMs = Date.now() - Date.parse(top.lastOpenedAt);
      if (topKey === normKey && Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 6e4) {
        return current;
      }
    }
    const filtered = current.filter((item) => {
      const itemKey = process.platform === "win32" ? toPosixPath(item.path).toLowerCase() : toPosixPath(item.path);
      return itemKey !== normKey;
    });
    const updated = [
      {
        path: posix,
        label,
        kind,
        lastOpenedAt: (/* @__PURE__ */ new Date()).toISOString()
      },
      ...filtered
    ].slice(0, maxItems);
    atomicWriteFileSync(this.recentFilePath, JSON.stringify(updated, null, 2));
    return updated;
  }
  getRecentTargets() {
    try {
      if (!import_node_fs2.default.existsSync(this.recentFilePath)) return [];
      const raw = JSON.parse(import_node_fs2.default.readFileSync(this.recentFilePath, "utf8"));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }
  getPreferences() {
    try {
      if (!import_node_fs2.default.existsSync(this.preferencesFilePath)) {
        return { themeOverride: "system", compactMode: false, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
      }
      return JSON.parse(import_node_fs2.default.readFileSync(this.preferencesFilePath, "utf8"));
    } catch {
      return { themeOverride: "system", compactMode: false, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
    }
  }
  savePreferences(patch) {
    const merged = {
      ...this.getPreferences(),
      ...patch,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    atomicWriteFileSync(this.preferencesFilePath, JSON.stringify(merged, null, 2));
    return merged;
  }
};

// src/core/snapshot-engine.ts
var import_node_crypto2 = __toESM(require("node:crypto"), 1);
var import_node_fs3 = __toESM(require("node:fs"), 1);
var import_node_path3 = __toESM(require("node:path"), 1);
var MAX_SNAPSHOT_FILE_BYTES = 5 * 1024 * 1024;
var DEFAULT_MAX_CHECKPOINTS = 50;
var DEFAULT_MAX_WORKSPACE_BLOBS_BYTES = 200 * 1024 * 1024;
function sha256Buffer(buf) {
  return import_node_crypto2.default.createHash("sha256").update(buf).digest("hex");
}
function hashFileSync(absPath, maxBytes = MAX_SNAPSHOT_FILE_BYTES) {
  try {
    const st = import_node_fs3.default.lstatSync(absPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      return { exists: true, isFile: false, size: st.size, sha256: null };
    }
    if (st.size > maxBytes) {
      return { exists: true, isFile: true, size: st.size, sha256: null, tooLarge: true };
    }
    const buf = import_node_fs3.default.readFileSync(absPath);
    return { exists: true, isFile: true, size: buf.length, sha256: sha256Buffer(buf) };
  } catch {
    return { exists: false, isFile: false, size: 0, sha256: null };
  }
}
function buildTurnKey(conversationId, lastUserInput, modelName) {
  const conv = (conversationId || "local").slice(0, 36);
  const modelTag = (modelName || "default").trim().toLowerCase().slice(0, 32);
  const promptDigest = import_node_crypto2.default.createHash("sha256").update((lastUserInput ?? "manual").trim()).digest("hex").slice(0, 12);
  return `${conv}:${modelTag}:${promptDigest}`;
}
var SnapshotEngine = class {
  snapshotsRoot;
  auditLogPath;
  maxFileBytes;
  maxCheckpoints;
  maxWorkspaceBlobBytes;
  turnIdleSplitMs;
  constructor(dataDir, auditLogPath, limits = {}) {
    this.snapshotsRoot = import_node_path3.default.join(dataDir, "snapshots");
    this.auditLogPath = auditLogPath;
    this.maxFileBytes = limits.maxFileBytes ?? MAX_SNAPSHOT_FILE_BYTES;
    this.maxCheckpoints = limits.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;
    this.maxWorkspaceBlobBytes = limits.maxWorkspaceBlobBytes ?? DEFAULT_MAX_WORKSPACE_BLOBS_BYTES;
    this.turnIdleSplitMs = limits.turnIdleSplitMs ?? 3e4;
    import_node_fs3.default.mkdirSync(this.snapshotsRoot, { recursive: true });
  }
  getWorkspaceDir(workspaceId) {
    return import_node_path3.default.join(this.snapshotsRoot, workspaceId);
  }
  getIndexPath(workspaceId) {
    return import_node_path3.default.join(this.getWorkspaceDir(workspaceId), "index.json");
  }
  getBlobPath(workspaceId, sha256) {
    return import_node_path3.default.join(this.getWorkspaceDir(workspaceId), "blobs", sha256.slice(0, 2), `${sha256}.blob`);
  }
  withWorkspaceLock(workspaceId, fn) {
    const wsDir = this.getWorkspaceDir(workspaceId);
    import_node_fs3.default.mkdirSync(wsDir, { recursive: true });
    const lockPath = import_node_path3.default.join(wsDir, "index.lock");
    const staleThresholdMs = 3e3;
    let acquired = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const fd = import_node_fs3.default.openSync(lockPath, "wx");
        import_node_fs3.default.writeSync(fd, `${process.pid}:${Date.now()}`);
        import_node_fs3.default.closeSync(fd);
        acquired = true;
        break;
      } catch {
        try {
          const st = import_node_fs3.default.statSync(lockPath);
          if (Date.now() - st.mtimeMs > staleThresholdMs) {
            import_node_fs3.default.unlinkSync(lockPath);
            continue;
          }
        } catch {
        }
        try {
          const sab = new SharedArrayBuffer(4);
          Atomics.wait(new Int32Array(sab), 0, 0, 15);
        } catch {
        }
      }
    }
    try {
      return fn();
    } finally {
      if (acquired) {
        try {
          import_node_fs3.default.unlinkSync(lockPath);
        } catch {
        }
      }
    }
  }
  readIndex(workspaceId, canonicalWorkspaceRoot) {
    const indexPath = this.getIndexPath(workspaceId);
    try {
      if (import_node_fs3.default.existsSync(indexPath)) {
        const parsed = JSON.parse(import_node_fs3.default.readFileSync(indexPath, "utf8"));
        if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.checkpoints)) {
          return parsed;
        }
      }
    } catch {
    }
    return {
      schemaVersion: 1,
      workspaceId,
      workspaceRoot: canonicalWorkspaceRoot,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      checkpoints: []
    };
  }
  writeIndex(index) {
    index.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    atomicWriteFileSync(this.getIndexPath(index.workspaceId), JSON.stringify(index, null, 2));
  }
  writeBlobIfMissing(workspaceId, buf) {
    const hash = sha256Buffer(buf);
    const blobPath = this.getBlobPath(workspaceId, hash);
    if (!import_node_fs3.default.existsSync(blobPath)) {
      atomicWriteFileSync(blobPath, buf);
    }
    return hash;
  }
  readBlobVerified(workspaceId, expectedSha256) {
    const blobPath = this.getBlobPath(workspaceId, expectedSha256);
    if (!import_node_fs3.default.existsSync(blobPath)) return null;
    try {
      const buf = import_node_fs3.default.readFileSync(blobPath);
      if (sha256Buffer(buf) !== expectedSha256) return null;
      return buf;
    } catch {
      return null;
    }
  }
  /**
   * Enforces LRU checkpoint retention (`maxCheckpoints` & `maxWorkspaceBlobBytes`)
   * and garbage-collects unreferenced content-addressed blobs.
   * Uses O(files) in-memory byte accounting so the common non-evicting PreToolUse path performs ZERO directory scans!
   */
  enforceQuotaSync(index) {
    let evictedCount = 0;
    while (index.checkpoints.length > this.maxCheckpoints) {
      index.checkpoints.pop();
      evictedCount++;
    }
    const collectReferencedSizes = () => {
      const refs = /* @__PURE__ */ new Map();
      for (const cp of index.checkpoints) {
        for (const f of cp.files) {
          if (f.preSha256 && !refs.has(f.preSha256)) {
            refs.set(f.preSha256, f.preBytes);
          }
        }
      }
      return refs;
    };
    let refMap = collectReferencedSizes();
    let referencedBytes = 0;
    for (const sz of refMap.values()) referencedBytes += sz;
    while (referencedBytes > this.maxWorkspaceBlobBytes && index.checkpoints.length > 1) {
      index.checkpoints.pop();
      evictedCount++;
      refMap = collectReferencedSizes();
      referencedBytes = 0;
      for (const sz of refMap.values()) referencedBytes += sz;
    }
    if (evictedCount === 0) return;
    const blobsRoot = import_node_path3.default.join(this.getWorkspaceDir(index.workspaceId), "blobs");
    let totalBytes = referencedBytes;
    if (import_node_fs3.default.existsSync(blobsRoot)) {
      let diskRemainingBytes = 0;
      for (const prefixDir of import_node_fs3.default.readdirSync(blobsRoot)) {
        const subDir = import_node_path3.default.join(blobsRoot, prefixDir);
        let st;
        try {
          st = import_node_fs3.default.statSync(subDir);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        for (const name of import_node_fs3.default.readdirSync(subDir)) {
          if (!name.endsWith(".blob")) continue;
          const hash = name.slice(0, -".blob".length);
          const fullPath = import_node_path3.default.join(subDir, name);
          if (!refMap.has(hash)) {
            try {
              import_node_fs3.default.unlinkSync(fullPath);
            } catch {
            }
          } else {
            try {
              diskRemainingBytes += import_node_fs3.default.statSync(fullPath).size;
            } catch {
            }
          }
        }
      }
      totalBytes = diskRemainingBytes;
    }
    appendAuditLogSync(this.auditLogPath, {
      event: "snapshot_quota_evict",
      actor: "system",
      workspaceId: index.workspaceId,
      detail: { evictedCheckpoints: evictedCount, remainingCheckpoints: index.checkpoints.length, totalBytes }
    });
  }
  /**
   * Called synchronously from `PreToolUse` BEFORE `write_file` / `edit_file` mutates disk.
   * Designed for `< 50ms` execution.
   */
  capturePreToolSnapshot(input) {
    const start = performance.now();
    let guard;
    try {
      guard = new PathGuard(input.workspaceRoot);
    } catch {
      return {
        captured: false,
        skippedReason: "OUTSIDE_WORKSPACE",
        durationMs: Math.round((performance.now() - start) * 100) / 100
      };
    }
    let resolved;
    try {
      resolved = guard.resolvePath(input.targetPath, { allowSensitive: true });
    } catch {
      return {
        captured: false,
        skippedReason: "OUTSIDE_WORKSPACE",
        durationMs: Math.round((performance.now() - start) * 100) / 100
      };
    }
    if (resolved.relativePath === "") {
      return {
        captured: false,
        skippedReason: "NOT_REGULAR_FILE",
        durationMs: Math.round((performance.now() - start) * 100) / 100
      };
    }
    const workspaceId = computeWorkspaceId(guard.workspaceRoot);
    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const conversationId = input.conversationId || "local";
    const cleanModelName = input.modelName?.trim() || void 0;
    const turnKey = buildTurnKey(conversationId, input.lastUserInput, cleanModelName);
    const label = sanitizeUntrustedIdentifier(input.lastUserInput || `${input.toolName} on ${resolved.relativePath}`, 96);
    const toolCallId = input.toolCallId || `step_${input.stepIdx ?? 0}_${nowMs}`;
    let skippedReason;
    let existedBefore = false;
    let preBytes = 0;
    if (isSensitivePath(resolved.relativePath)) {
      skippedReason = "SENSITIVE_BLOCKED";
    }
    const checkpointId = this.withWorkspaceLock(workspaceId, () => {
      const index = this.readIndex(workspaceId, guard.workspaceRoot);
      let checkpoint = index.checkpoints[0];
      const prevUpdatedMs = checkpoint ? Date.parse(checkpoint.updatedAt) : NaN;
      const idleExceeded = Number.isFinite(prevUpdatedMs) && (nowMs - prevUpdatedMs > this.turnIdleSplitMs || prevUpdatedMs - nowMs > this.turnIdleSplitMs);
      const stepRegressed = input.stepIdx !== void 0 && checkpoint?.lastStepIdx !== void 0 && input.stepIdx < checkpoint.lastStepIdx;
      if (!checkpoint || checkpoint.turnKey !== turnKey || checkpoint.kind !== "agent_turn" || idleExceeded || stepRegressed) {
        checkpoint = {
          id: `cp_${nowMs}_${import_node_crypto2.default.randomBytes(3).toString("hex")}`,
          turnKey,
          conversationId,
          ...cleanModelName ? { modelName: cleanModelName } : {},
          ...input.stepIdx !== void 0 ? { lastStepIdx: input.stepIdx } : {},
          kind: "agent_turn",
          label: label || "Agent workspace edit",
          createdAt: nowIso,
          updatedAt: nowIso,
          files: []
        };
        index.checkpoints.unshift(checkpoint);
      } else {
        checkpoint.updatedAt = nowIso;
        if (input.stepIdx !== void 0) {
          checkpoint.lastStepIdx = input.stepIdx;
        }
      }
      const existingEntry = checkpoint.files.find((f) => f.relativePath === resolved.relativePath);
      if (!existingEntry) {
        let preExistingParentRelPath;
        let preMode;
        let fileBuf = null;
        if (!skippedReason && resolved.exists) {
          try {
            const st = import_node_fs3.default.lstatSync(resolved.absolutePath);
            if (!st.isFile() || st.isSymbolicLink()) {
              skippedReason = "NOT_REGULAR_FILE";
            } else if (st.size > this.maxFileBytes) {
              existedBefore = true;
              preBytes = st.size;
              skippedReason = "TOO_LARGE";
            } else {
              existedBefore = true;
              if (process.platform !== "win32") {
                preMode = st.mode & 511;
              }
              fileBuf = import_node_fs3.default.readFileSync(resolved.absolutePath);
              preBytes = fileBuf.length;
            }
          } catch {
            existedBefore = false;
          }
        }
        if (!existedBefore && !skippedReason) {
          let anc = import_node_path3.default.dirname(resolved.absolutePath);
          while (!import_node_fs3.default.existsSync(anc)) {
            const relToRoot = import_node_path3.default.relative(guard.workspaceRoot, anc);
            if (!relToRoot || relToRoot === ".." || relToRoot.startsWith(`..${import_node_path3.default.sep}`) || import_node_path3.default.isAbsolute(relToRoot)) {
              anc = guard.workspaceRoot;
              break;
            }
            const nextAnc = import_node_path3.default.dirname(anc);
            if (nextAnc === anc) break;
            anc = nextAnc;
          }
          const finalRel = toPosixPath(import_node_path3.default.relative(guard.workspaceRoot, anc));
          preExistingParentRelPath = finalRel === ".." || finalRel.startsWith("../") ? "" : finalRel;
        }
        const preSha256 = fileBuf ? this.writeBlobIfMissing(workspaceId, fileBuf) : null;
        checkpoint.files.push({
          relativePath: resolved.relativePath,
          existedBefore,
          ...preExistingParentRelPath !== void 0 ? { preExistingParentRelPath } : {},
          ...preMode !== void 0 ? { preMode } : {},
          preSha256,
          preBytes,
          postSha256: null,
          postExisted: null,
          toolCallIds: [toolCallId],
          lastToolName: input.toolName,
          ...skippedReason ? { skippedReason } : {},
          firstCapturedAt: nowIso,
          updatedAt: nowIso
        });
        this.enforceQuotaSync(index);
      } else {
        existedBefore = existingEntry.existedBefore;
        preBytes = existingEntry.preBytes;
        skippedReason = existingEntry.skippedReason;
        if (!existingEntry.toolCallIds.includes(toolCallId)) {
          existingEntry.toolCallIds.push(toolCallId);
        }
        existingEntry.lastToolName = input.toolName;
        existingEntry.updatedAt = nowIso;
      }
      this.writeIndex(index);
      return checkpoint.id;
    });
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    appendAuditLogSync(this.auditLogPath, {
      event: "snapshot_pre",
      actor: "hook",
      workspaceId,
      detail: {
        checkpointId,
        relativePath: resolved.relativePath,
        existedBefore,
        preBytes,
        skippedReason: skippedReason ?? null,
        durationMs
      }
    });
    return {
      captured: !skippedReason,
      checkpointId,
      relativePath: resolved.relativePath,
      skippedReason,
      durationMs
    };
  }
  /**
   * Called synchronously from `PostToolUse` AFTER `write_file` / `edit_file` finishes.
   * Records `postSha256` on the checkpoint entry to enable exact 3-way conflict detection!
   */
  capturePostToolSnapshot(input) {
    const start = performance.now();
    let guard;
    try {
      guard = new PathGuard(input.workspaceRoot);
    } catch {
      return { updated: false, durationMs: Math.round((performance.now() - start) * 100) / 100 };
    }
    let resolved;
    try {
      resolved = guard.resolvePath(input.targetPath, { allowSensitive: true });
    } catch {
      return { updated: false, durationMs: Math.round((performance.now() - start) * 100) / 100 };
    }
    if (isSensitivePath(resolved.relativePath) || resolved.relativePath === "") {
      return { updated: false, durationMs: Math.round((performance.now() - start) * 100) / 100 };
    }
    const workspaceId = computeWorkspaceId(guard.workspaceRoot);
    const postDisk = hashFileSync(resolved.absolutePath, this.maxFileBytes);
    if (postDisk.tooLarge) {
      return { updated: false, durationMs: Math.round((performance.now() - start) * 100) / 100 };
    }
    const nowIso = new Date(input.nowMs ?? Date.now()).toISOString();
    const updated = this.withWorkspaceLock(workspaceId, () => {
      const index = this.readIndex(workspaceId, guard.workspaceRoot);
      const toolCallId = input.toolCallId;
      for (const cp of index.checkpoints) {
        const match = cp.files.find(
          (f) => f.relativePath === resolved.relativePath && (!toolCallId || f.toolCallIds.includes(toolCallId))
        );
        if (match) {
          match.postExisted = postDisk.exists && postDisk.isFile;
          match.postSha256 = postDisk.sha256;
          match.updatedAt = nowIso;
          cp.updatedAt = nowIso;
          this.writeIndex(index);
          return true;
        }
      }
      const newestMatch = index.checkpoints[0]?.files.find((f) => f.relativePath === resolved.relativePath);
      if (newestMatch && index.checkpoints[0]) {
        newestMatch.postExisted = postDisk.exists && postDisk.isFile;
        newestMatch.postSha256 = postDisk.sha256;
        newestMatch.updatedAt = nowIso;
        index.checkpoints[0].updatedAt = nowIso;
        this.writeIndex(index);
        return true;
      }
      return false;
    });
    return {
      updated,
      durationMs: Math.round((performance.now() - start) * 100) / 100
    };
  }
  listCheckpoints(workspaceRootInput) {
    const guard = new PathGuard(workspaceRootInput);
    const workspaceId = computeWorkspaceId(guard.workspaceRoot);
    return this.readIndex(workspaceId, guard.workspaceRoot).checkpoints;
  }
  /**
   * Computes the exact rollback plan from current disk state back to BEFORE `checkpointId`
   * (rolling back `checkpointId` and any newer `agent_turn` checkpoints stacked on top of it,
   * OR if `checkpointId` is a `pre_rollback_backup`, restoring directly to that backup!).
   */
  previewRollback(workspaceRootInput, checkpointId, onlyPaths) {
    const guard = new PathGuard(workspaceRootInput);
    const workspaceId = computeWorkspaceId(guard.workspaceRoot);
    const index = this.readIndex(workspaceId, guard.workspaceRoot);
    const targetIdx = index.checkpoints.findIndex((cp) => cp.id === checkpointId);
    if (targetIdx === -1) return null;
    const targetCp = index.checkpoints[targetIdx];
    const sliceOldestToNewest = index.checkpoints.slice(0, targetIdx + 1).reverse();
    const effectiveSequence = targetCp.kind === "pre_rollback_backup" ? [targetCp] : sliceOldestToNewest;
    const normalizedOnlyPaths = onlyPaths && onlyPaths.length > 0 ? onlyPaths.map((p) => toPosixPath(p).replace(/^\.\//, "")) : void 0;
    const filterSet = normalizedOnlyPaths ? new Set(normalizedOnlyPaths) : null;
    const perFile = /* @__PURE__ */ new Map();
    for (const cp of effectiveSequence) {
      for (const entry of cp.files) {
        if (filterSet && !filterSet.has(entry.relativePath)) continue;
        const existing = perFile.get(entry.relativePath);
        if (!existing) {
          perFile.set(entry.relativePath, {
            baselineEntry: entry,
            latestPostSha256: entry.postSha256,
            latestPostExisted: entry.postExisted
          });
        } else if (entry.postSha256 !== null || entry.postExisted !== null) {
          existing.latestPostSha256 = entry.postSha256;
          existing.latestPostExisted = entry.postExisted;
        }
      }
    }
    const plans = [];
    for (const [relativePath, info] of perFile.entries()) {
      const { baselineEntry, latestPostSha256, latestPostExisted } = info;
      if (baselineEntry.skippedReason) {
        plans.push({
          relativePath,
          disposition: "SKIPPED_UNTRACKED",
          existedBefore: baselineEntry.existedBefore,
          targetPreSha256: null,
          latestTrackedPostSha256: latestPostSha256,
          currentDiskSha256: null,
          currentDiskExists: false,
          reason: `File was skipped during capture (${baselineEntry.skippedReason}).`
        });
        continue;
      }
      const resolved = guard.resolvePath(relativePath);
      const disk = hashFileSync(resolved.absolutePath, this.maxFileBytes);
      if (baselineEntry.existedBefore) {
        if (!baselineEntry.preSha256 || !this.readBlobVerified(workspaceId, baselineEntry.preSha256)) {
          plans.push({
            relativePath,
            disposition: "ERROR_MISSING_BLOB",
            existedBefore: true,
            targetPreSha256: baselineEntry.preSha256,
            latestTrackedPostSha256: latestPostSha256,
            currentDiskSha256: disk.sha256,
            currentDiskExists: disk.exists,
            reason: "Snapshot blob is missing or failed SHA-256 verification."
          });
          continue;
        }
      }
      if (!baselineEntry.existedBefore && !disk.exists) {
        plans.push({
          relativePath,
          disposition: "NOOP_ALREADY_MATCHES",
          existedBefore: false,
          targetPreSha256: null,
          latestTrackedPostSha256: latestPostSha256,
          currentDiskSha256: null,
          currentDiskExists: false,
          reason: "File is already absent on disk."
        });
        continue;
      }
      if (baselineEntry.existedBefore && disk.exists && disk.sha256 === baselineEntry.preSha256) {
        plans.push({
          relativePath,
          disposition: "NOOP_ALREADY_MATCHES",
          existedBefore: true,
          targetPreSha256: baselineEntry.preSha256,
          latestTrackedPostSha256: latestPostSha256,
          currentDiskSha256: disk.sha256,
          currentDiskExists: true,
          reason: "Current disk content already matches checkpoint baseline."
        });
        continue;
      }
      const matchesLatestAgentState = latestPostExisted === false ? !disk.exists : latestPostSha256 !== null && disk.exists && disk.sha256 === latestPostSha256;
      if (!matchesLatestAgentState) {
        plans.push({
          relativePath,
          disposition: "CONFLICT_HUMAN_MODIFIED",
          existedBefore: baselineEntry.existedBefore,
          ...baselineEntry.preExistingParentRelPath !== void 0 ? { preExistingParentRelPath: baselineEntry.preExistingParentRelPath } : {},
          ...baselineEntry.preMode !== void 0 ? { preMode: baselineEntry.preMode } : {},
          targetPreSha256: baselineEntry.preSha256,
          latestTrackedPostSha256: latestPostSha256,
          currentDiskSha256: disk.sha256,
          currentDiskExists: disk.exists,
          reason: latestPostSha256 === null ? "Post-tool hash was not recorded; file may contain manual changes." : "File was modified on disk after the Agent edit (manual edit detected)."
        });
        continue;
      }
      plans.push({
        relativePath,
        disposition: baselineEntry.existedBefore ? "READY_CLEAN_RESTORE" : "READY_CLEAN_DELETE_CREATED",
        existedBefore: baselineEntry.existedBefore,
        ...baselineEntry.preExistingParentRelPath !== void 0 ? { preExistingParentRelPath: baselineEntry.preExistingParentRelPath } : {},
        ...baselineEntry.preMode !== void 0 ? { preMode: baselineEntry.preMode } : {},
        targetPreSha256: baselineEntry.preSha256,
        latestTrackedPostSha256: latestPostSha256,
        currentDiskSha256: disk.sha256,
        currentDiskExists: disk.exists,
        reason: baselineEntry.existedBefore ? "Ready to restore pre-edit file content." : "Ready to remove file created during Agent turn (current bytes backed up first)."
      });
    }
    const conflictCount = plans.filter((p) => p.disposition === "CONFLICT_HUMAN_MODIFIED").length;
    const hasMissingBlobs = plans.some((p) => p.disposition === "ERROR_MISSING_BLOB");
    const actionableCount = plans.filter(
      (p) => p.disposition === "READY_CLEAN_RESTORE" || p.disposition === "READY_CLEAN_DELETE_CREATED" || p.disposition === "CONFLICT_HUMAN_MODIFIED"
    ).length;
    return {
      checkpointId: targetCp.id,
      checkpointLabel: targetCp.label,
      ...normalizedOnlyPaths ? { onlyPaths: normalizedOnlyPaths } : {},
      canRestoreCleanly: !hasMissingBlobs && conflictCount === 0,
      hasConflicts: conflictCount > 0,
      hasMissingBlobs,
      actionableCount,
      conflictCount,
      files: plans
    };
  }
  /**
   * Executes a human-confirmed rollback (`visibility: ["app"]` only!).
   * Enforces:
   * 1. Conflict gate unless `allowOverwriteConflicts === true`.
   * 2. Mandatory Undo-of-Undo backup checkpoint BEFORE mutating any workspace file.
   * 3. Atomic file writes and audit logging.
   */
  restoreCheckpoint(workspaceRootInput, checkpointId, options = {}) {
    const guard = new PathGuard(workspaceRootInput);
    const workspaceId = computeWorkspaceId(guard.workspaceRoot);
    return this.withWorkspaceLock(workspaceId, () => {
      const preview = this.previewRollback(guard.workspaceRoot, checkpointId, options.onlyPaths);
      if (!preview) {
        return {
          status: "ERROR_NOT_FOUND",
          checkpointId,
          backupCheckpointId: null,
          restoredPaths: [],
          deletedCreatedPaths: [],
          skippedPaths: [],
          conflicts: [],
          preview: null,
          message: `Checkpoint "${checkpointId}" was not found.`
        };
      }
      if (preview.hasMissingBlobs) {
        return {
          status: "ERROR_MISSING_BLOB",
          checkpointId,
          backupCheckpointId: null,
          restoredPaths: [],
          deletedCreatedPaths: [],
          skippedPaths: [],
          conflicts: [],
          preview,
          message: "Rollback aborted: one or more snapshot blobs failed integrity verification."
        };
      }
      const conflicts = preview.files.filter((f) => f.disposition === "CONFLICT_HUMAN_MODIFIED");
      if (conflicts.length > 0 && options.allowOverwriteConflicts !== true) {
        appendAuditLogSync(this.auditLogPath, {
          event: "rollback_blocked_conflict",
          actor: "app",
          workspaceId,
          detail: { checkpointId, conflictPaths: conflicts.map((c) => c.relativePath) }
        });
        return {
          status: "BLOCKED_CONFLICT",
          checkpointId,
          backupCheckpointId: null,
          restoredPaths: [],
          deletedCreatedPaths: [],
          skippedPaths: [],
          conflicts,
          preview,
          message: `Rollback paused: ${conflicts.length} file(s) have manual edits since the Agent turn. Review conflicts to confirm.`
        };
      }
      const actionable = preview.files.filter(
        (f) => f.disposition === "READY_CLEAN_RESTORE" || f.disposition === "READY_CLEAN_DELETE_CREATED" || f.disposition === "CONFLICT_HUMAN_MODIFIED" && options.allowOverwriteConflicts === true
      );
      if (actionable.length === 0) {
        return {
          status: "NOOP",
          checkpointId,
          backupCheckpointId: null,
          restoredPaths: [],
          deletedCreatedPaths: [],
          skippedPaths: preview.files.map((f) => f.relativePath),
          conflicts: [],
          preview,
          message: "Workspace already matches the selected checkpoint."
        };
      }
      const nowIso = (/* @__PURE__ */ new Date()).toISOString();
      const backupCpId = `cp_backup_${Date.now()}_${import_node_crypto2.default.randomBytes(3).toString("hex")}`;
      const index = this.readIndex(workspaceId, guard.workspaceRoot);
      const backupEntries = [];
      const maxUndoBackupBytes = Math.max(this.maxFileBytes * 4, 20 * 1024 * 1024);
      for (const plan of actionable) {
        const resolved = guard.resolvePath(plan.relativePath);
        let existedNow = false;
        let curSha = null;
        let curBytes = 0;
        let curMode;
        if (import_node_fs3.default.existsSync(resolved.absolutePath)) {
          const curStat = import_node_fs3.default.lstatSync(resolved.absolutePath);
          if (!curStat.isSymbolicLink() && curStat.isFile()) {
            if (curStat.size > maxUndoBackupBytes) {
              return {
                status: "ERROR_MISSING_BLOB",
                checkpointId,
                backupCheckpointId: null,
                restoredPaths: [],
                deletedCreatedPaths: [],
                skippedPaths: [],
                conflicts,
                preview,
                message: `Rollback aborted safely: current disk file "${plan.relativePath}" (${curStat.size} bytes) exceeds safe Undo-backup limit.`
              };
            }
            const curBuf = import_node_fs3.default.readFileSync(resolved.absolutePath);
            existedNow = true;
            curBytes = curBuf.length;
            if (process.platform !== "win32") {
              curMode = curStat.mode & 511;
            }
            curSha = this.writeBlobIfMissing(workspaceId, curBuf);
          }
        }
        backupEntries.push({
          relativePath: plan.relativePath,
          existedBefore: existedNow,
          ...curMode !== void 0 ? { preMode: curMode } : {},
          preSha256: curSha,
          preBytes: curBytes,
          postSha256: plan.targetPreSha256,
          postExisted: plan.existedBefore,
          toolCallIds: ["app_restore_checkpoint"],
          lastToolName: "app_restore_checkpoint",
          firstCapturedAt: nowIso,
          updatedAt: nowIso
        });
      }
      const backupCheckpoint = {
        id: backupCpId,
        turnKey: `backup:${backupCpId}`,
        conversationId: "human-ui",
        kind: "pre_rollback_backup",
        label: `Undo backup before restoring "${preview.checkpointLabel}"`,
        createdAt: nowIso,
        updatedAt: nowIso,
        files: backupEntries
      };
      index.checkpoints.unshift(backupCheckpoint);
      const restoredPaths = [];
      const deletedCreatedPaths = [];
      for (const plan of actionable) {
        const resolved = guard.resolvePath(plan.relativePath);
        if (plan.existedBefore && plan.targetPreSha256) {
          const blobBuf = this.readBlobVerified(workspaceId, plan.targetPreSha256);
          if (!blobBuf) {
            throw new Error(`Unexpected missing blob for ${plan.relativePath}`);
          }
          atomicWriteFileSync(resolved.absolutePath, blobBuf, plan.preMode);
          restoredPaths.push(plan.relativePath);
        } else if (!plan.existedBefore) {
          try {
            const st = import_node_fs3.default.lstatSync(resolved.absolutePath);
            if (!st.isSymbolicLink() && st.isFile()) {
              import_node_fs3.default.unlinkSync(resolved.absolutePath);
            }
          } catch {
          }
          const stopBoundaryAbs = plan.preExistingParentRelPath && plan.preExistingParentRelPath.length > 0 ? import_node_path3.default.resolve(guard.workspaceRoot, plan.preExistingParentRelPath) : guard.workspaceRoot;
          let parentDir = import_node_path3.default.dirname(resolved.absolutePath);
          while (true) {
            const relFromStop = import_node_path3.default.relative(stopBoundaryAbs, parentDir);
            if (!relFromStop || relFromStop === ".." || relFromStop.startsWith(`..${import_node_path3.default.sep}`) || import_node_path3.default.isAbsolute(relFromStop)) {
              break;
            }
            try {
              const entries = import_node_fs3.default.readdirSync(parentDir);
              if (entries.length > 0) break;
              import_node_fs3.default.rmdirSync(parentDir);
              const nextParent = import_node_path3.default.dirname(parentDir);
              if (nextParent === parentDir) break;
              parentDir = nextParent;
            } catch {
              break;
            }
          }
          deletedCreatedPaths.push(plan.relativePath);
        }
      }
      for (const cp of index.checkpoints) {
        if (cp.id === backupCpId) continue;
        for (const f of cp.files) {
          const restoredPlan = actionable.find((a) => a.relativePath === f.relativePath);
          if (restoredPlan) {
            f.postExisted = restoredPlan.existedBefore;
            f.postSha256 = restoredPlan.targetPreSha256;
          }
        }
      }
      this.enforceQuotaSync(index);
      this.writeIndex(index);
      const skippedPaths = preview.files.filter((f) => f.disposition === "SKIPPED_UNTRACKED" || f.disposition === "NOOP_ALREADY_MATCHES").map((f) => f.relativePath);
      appendAuditLogSync(this.auditLogPath, {
        event: "rollback_completed",
        actor: "app",
        workspaceId,
        detail: {
          checkpointId,
          backupCheckpointId: backupCpId,
          restoredPaths,
          deletedCreatedPaths,
          overwroteConflicts: conflicts.length > 0
        }
      });
      return {
        status: "RESTORED",
        checkpointId,
        backupCheckpointId: backupCpId,
        restoredPaths,
        deletedCreatedPaths,
        skippedPaths,
        conflicts,
        preview,
        message: `Restored ${restoredPaths.length} file(s) and cleaned ${deletedCreatedPaths.length} Agent-created file(s). Pre-rollback safety backup saved as ${backupCpId}.`
      };
    });
  }
};

// src/shared/identity.ts
var DIFFATLAS_IDENTITY = {
  id: "diffatlas",
  displayName: "DiffAtlas",
  version: "0.1.0",
  resourceUri: "ui://diffatlas/app.html",
  appHtmlEnvVar: "DIFFATLAS_APP_HTML"
};

// src/hooks/lifecycle-hook.ts
var MAX_HOOK_STDIN_BYTES = 2 * 1024 * 1024;
function readStdinAsync(maxBytes = MAX_HOOK_STDIN_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    process.stdin.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      if (totalBytes + buf.length > maxBytes) {
        const remaining = Math.max(0, maxBytes - totalBytes);
        if (remaining > 0) chunks.push(buf.subarray(0, remaining));
        totalBytes = maxBytes;
        process.stdin.pause();
        finish();
        return;
      }
      chunks.push(buf);
      totalBytes += buf.length;
    });
    process.stdin.on("end", () => finish());
    process.stdin.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
    process.stdin.resume();
  });
}
function extractTargetPathFromArgs(args) {
  if (!args) return null;
  if (args.ArtifactMetadata && typeof args.ArtifactMetadata === "object") {
    return null;
  }
  const candidates = [
    args.Path,
    args.TargetFile,
    args.AbsolutePath,
    args.FilePath,
    args.path,
    args.filePath,
    args.targetFile,
    args.file_path,
    args.target_file
  ];
  for (const cand of candidates) {
    if (typeof cand === "string" && cand.trim().length > 0) {
      const trimmed = cand.trim();
      if (trimmed.toLowerCase().startsWith("file://")) {
        const converted = fromFileUri(trimmed);
        if (converted) return converted;
      }
      return trimmed;
    }
  }
  return null;
}
function normalizeDirKey(dirPath) {
  const posix = toPosixPath(import_node_path4.default.resolve(dirPath));
  return process.platform === "win32" ? posix.toLowerCase() : posix;
}
function emitHookResponseAndExit(eventName) {
  if (eventName === "PostToolUse") {
    process.stdout.write("{}\n");
  } else {
    process.stdout.write('{"decision":"allow"}\n');
  }
  process.exit(0);
}
async function main() {
  let detectedEventName = "PreToolUse";
  const cancelWatchdog = installHookFailOpenWatchdog(3500, () => {
    emitHookResponseAndExit(detectedEventName);
  });
  try {
    const rawStdin = (await readStdinAsync()).trim();
    if (!rawStdin) {
      cancelWatchdog();
      emitHookResponseAndExit("PreToolUse");
    }
    const payload = JSON.parse(rawStdin);
    detectedEventName = payload.hookEventName ?? "PreToolUse";
    const targetPath = extractTargetPathFromArgs(payload.toolCall?.args);
    if (!targetPath) {
      cancelWatchdog();
      emitHookResponseAndExit(detectedEventName);
    }
    const pluginRootKey = process.env.PLUGIN_ROOT ? normalizeDirKey(process.env.PLUGIN_ROOT) : null;
    const isPluginSelfDir = (p) => {
      if (pluginRootKey && normalizeDirKey(p) === pluginRootKey) return true;
      return /(?:^|\/)(?:\.agents?|_agents?)\/plugins\/diffatlas(?:\/|$)/i.test(toPosixPath(p));
    };
    const rawRoots = [
      ...Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [],
      ...payload.cwd ? [payload.cwd] : []
    ].filter((p) => typeof p === "string" && p.trim().length > 0).map((p) => {
      const trimmed = p.trim();
      return trimmed.toLowerCase().startsWith("file://") ? fromFileUri(trimmed) ?? trimmed : trimmed;
    }).filter((p) => !isPluginSelfDir(p));
    const seenRootKeys = /* @__PURE__ */ new Set();
    const candidateRoots = rawRoots.filter((r) => {
      const key = normalizeDirKey(r);
      if (seenRootKeys.has(key)) return false;
      seenRootKeys.add(key);
      return true;
    }).sort((a, b) => import_node_path4.default.resolve(b).length - import_node_path4.default.resolve(a).length);
    if (candidateRoots.length === 0) {
      cancelWatchdog();
      emitHookResponseAndExit(detectedEventName);
    }
    const rawCwd = payload.cwd?.trim();
    const resolvedCwd = rawCwd && rawCwd.toLowerCase().startsWith("file://") ? fromFileUri(rawCwd) ?? rawCwd : rawCwd;
    const effectiveCwd = resolvedCwd && !isPluginSelfDir(resolvedCwd) ? resolvedCwd : void 0;
    const effectiveTargetPath = !import_node_path4.default.isAbsolute(targetPath) && effectiveCwd ? import_node_path4.default.resolve(effectiveCwd, targetPath) : targetPath;
    const runtimePaths = resolvePluginRuntimePaths(DIFFATLAS_IDENTITY);
    const engine = new SnapshotEngine(runtimePaths.dataDir, runtimePaths.auditLogPath);
    const toolName = payload.toolCall?.name ?? "file_edit";
    for (const root of candidateRoots) {
      if (detectedEventName === "PostToolUse") {
        if (!payload.error) {
          const res = engine.capturePostToolSnapshot({
            workspaceRoot: root,
            targetPath: effectiveTargetPath,
            toolName,
            toolCallId: payload.toolCall?.id,
            conversationId: payload.conversationId,
            modelName: payload.modelName,
            lastUserInput: payload.lastUserInput,
            stepIdx: payload.stepIdx
          });
          if (res.updated) break;
        }
      } else {
        const res = engine.capturePreToolSnapshot({
          workspaceRoot: root,
          targetPath: effectiveTargetPath,
          toolName,
          toolCallId: payload.toolCall?.id,
          conversationId: payload.conversationId,
          modelName: payload.modelName,
          lastUserInput: payload.lastUserInput,
          stepIdx: payload.stepIdx
        });
        if (res.captured) {
          new PluginStateStore(runtimePaths.stateDir).recordRecentTarget(root, "workspace");
        }
        if (res.captured || res.skippedReason !== "OUTSIDE_WORKSPACE") {
          break;
        }
      }
    }
  } catch (err) {
    try {
      const runtimePaths = resolvePluginRuntimePaths(DIFFATLAS_IDENTITY);
      appendAuditLogSync(runtimePaths.auditLogPath, {
        event: "hook_fail_open_warning",
        actor: "hook",
        detail: {
          hookEventName: detectedEventName ?? "unknown",
          error: err instanceof Error ? err.message : String(err)
        }
      });
    } catch {
    }
  } finally {
    cancelWatchdog();
  }
  emitHookResponseAndExit(detectedEventName);
}
void main();
