import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PathGuard, sanitizeUntrustedIdentifier, toFileUri } from '../kit/path-guard.js';
import { isAnalyzableCodeLanguage } from '../shared/languages.js';
import { collectCppIncludeRoots, parseCppImports } from './cpp-import-parser.js';
import { buildCSharpWorkspaceIndex, parseCSharpImports } from './csharp-import-parser.js';
import {
  inspectWorkspaceFiles,
  type GitFileStatus,
  type WorkspaceFileNode,
  type WorkspaceSnapshotSummary,
} from './git-workspace.js';
import { buildGoWorkspaceIndex, parseGoImports } from './go-import-parser.js';
import { buildJvmWorkspaceIndex, parseJvmImports } from './jvm-import-parser.js';
import { parsePythonImports } from './py-import-parser.js';
import { buildRustWorkspaceIndex, parseRustImports } from './rust-import-parser.js';
import { parseSfcImports } from './sfc-import-parser.js';
import {
  loadTsConfigPaths,
  parseTsJsImports,
  type ImportConfidence,
  type ImportEdgeKind,
  type ParsedImportRecord,
  type TsConfigPathConfig,
} from './ts-import-parser.js';

export type ImpactTier = 'changed' | 'direct_impact' | 'indirect_impact' | 'upstream_dependency';

export interface ImpactGraphNode {
  id: string;
  fileUri: string;
  language: WorkspaceFileNode['language'];
  gitStatus: GitFileStatus;
  isTestFile: boolean;
  tier: ImpactTier;
  hopDistance: number;
  inDegree: number;
  outDegree: number;
}

export interface ImpactGraphEdge {
  from: string;
  to: string;
  line: number;
  specifier: string;
  snippet: string;
  kind: ImportEdgeKind;
  confidence: ImportConfidence;
  note?: string;
}

export interface RecommendedTestEntry {
  testFile: string;
  fileUri: string;
  reason: 'direct_import' | 'transitive_import' | 'naming_convention';
  confidence: ImportConfidence;
  relatedChangedFile: string;
  evidence?: string;
}

export interface LowConfidenceWarning {
  sourceFile: string;
  line: number;
  specifier: string;
  kind: ImportEdgeKind;
  snippet: string;
  note: string;
}

export interface DiffImpactReport extends Record<string, unknown> {
  workspaceRoot: string;
  workspaceName: string;
  isGitRepo: boolean;
  hasInitialCommit: boolean;
  branchName: string | null;
  scanDurationMs: number;
  totalIndexedCodeFiles: number;
  totalGraphEdges: number;
  seedSource: 'explicit_targets' | 'git_status' | 'none';
  changedFiles: string[];
  directImpactedFiles: string[];
  indirectImpactedFiles: string[];
  recommendedTests: RecommendedTestEntry[];
  lowConfidenceWarnings: LowConfidenceWarning[];
  nodes: ImpactGraphNode[];
  edges: ImpactGraphEdge[];
  /** True when Git repo has no initial commit yet (all untracked files appear in Hop 0) */
  unbornGitRepo: boolean;
  /** Drift warning when changed file count exceeds healthy single-turn review threshold */
  scopeDriftWarning: string | null;
}

interface CachedFileParse {
  mtimeMs: number;
  size: number;
  topologyHash: string;
  imports: ParsedImportRecord[];
}

const MAX_PARSABLE_CODE_FILE_BYTES = 1024 * 1024; // 1 MiB safety limit per source file
const MAX_PARSE_CACHE_ENTRIES = 10_000;

function normalizeStemForTestMatch(relPosix: string): string {
  const base = path.posix.basename(relPosix);
  return base
    .replace(/\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, '')
    .replace(/_(?:unit)?test\.(py|go|rs|c|cc|cpp|cxx)$/i, '')
    .replace(/^test_/i, '')
    .replace(/IT\.(java|kt)$/, '')
    .replace(/(?:Tests?|Spec)\.(java|kt|cs|cpp|cc|cxx)$/i, '')
    .replace(/^Test(?=[A-Z0-9])/, '')
    .replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|astro|py|pyi|go|rs|c|h|cc|cpp|cxx|c\+\+|hpp|hh|hxx|h\+\+|ipp|inl|tpp|inc|java|kt|kts|cs)$/i, '')
    .toLowerCase()
    .replace(/[-_]/g, '');
}

/**
 * Deterministic Workspace Dependency Graph & Git Diff Blast-Radius Analyzer.
 * Supports incremental mtime+size caching for sub-300ms re-scans on large repositories.
 */
export class ImpactAnalyzer {
  private readonly fileParseCache = new Map<string, CachedFileParse>();

  public clearCache(): void {
    this.fileParseCache.clear();
  }

  public async analyzeImpact(
    workspaceRootInput: string,
    options?: {
      /** Optional explicit file paths to simulate/analyze impact (works in non-Git repos too) */
      targetFiles?: readonly string[];
      /** Optional pre-scanned workspace summary to eliminate duplicate git/disk scans */
      precomputedWorkspace?: WorkspaceSnapshotSummary;
      /** Max files to scan (default: 5,000) */
      maxFiles?: number;
      /** Scope drift alert threshold (default: 10 changed files) */
      driftThresholdFiles?: number;
    },
  ): Promise<DiffImpactReport> {
    const t0 = performance.now();
    const guard = new PathGuard(workspaceRootInput);
    const wsSummary =
      options?.precomputedWorkspace ?? (await inspectWorkspaceFiles(guard.workspaceRoot, options?.maxFiles ?? 5_000));
    const rootTsConfig = loadTsConfigPaths(guard.workspaceRoot);

    const fileNodeMap = new Map<string, WorkspaceFileNode>();
    const allFileSet = new Set<string>();
    const caseInsensitiveOs = process.platform === 'win32' || process.platform === 'darwin';
    const caseInsensitiveFileMap = caseInsensitiveOs ? new Map<string, string>() : undefined;
    const nestedTsConfigDirs = new Set<string>();
    const pyFileSet = new Set<string>();
    const pyBasenameIndex = new Map<string, string[]>();
    const jvmNodes: Array<{ relativePath: string; isTestFile: boolean; language: 'java' | 'kotlin' }> = [];
    const csNodes: Array<{ relativePath: string; isTestFile: boolean }> = [];
    let hasGoFiles = false;
    let hasRustFiles = false;
    let hasCppFiles = false;

    for (const node of wsSummary.files) {
      fileNodeMap.set(node.relativePath, node);
      allFileSet.add(node.relativePath);
      if (caseInsensitiveFileMap && node.gitStatus !== 'deleted') {
        const lowerRel = node.relativePath.toLowerCase();
        if (!caseInsensitiveFileMap.has(lowerRel)) {
          caseInsensitiveFileMap.set(lowerRel, node.relativePath);
        }
      }
      const baseName = path.posix.basename(node.relativePath);
      if ((baseName === 'tsconfig.json' || baseName === 'jsconfig.json') && node.gitStatus !== 'deleted') {
        const dirRel = path.posix.dirname(node.relativePath);
        if (dirRel !== '.' && dirRel !== '') {
          nestedTsConfigDirs.add(dirRel);
        }
      }
      if (node.language === 'python') {
        pyFileSet.add(node.relativePath);
        const stem = path.posix.basename(node.relativePath, path.posix.extname(node.relativePath));
        if (stem && stem !== '__init__') {
          const list = pyBasenameIndex.get(stem) ?? [];
          list.push(node.relativePath);
          pyBasenameIndex.set(stem, list);
        }
      } else if (node.language === 'go') {
        hasGoFiles = true;
      } else if (node.language === 'rust') {
        hasRustFiles = true;
      } else if (node.language === 'cpp') {
        hasCppFiles = true;
      } else if (
        (node.language === 'java' || node.language === 'kotlin') &&
        node.gitStatus !== 'deleted' &&
        node.sizeBytes <= MAX_PARSABLE_CODE_FILE_BYTES
      ) {
        jvmNodes.push({ relativePath: node.relativePath, isTestFile: node.isTestFile, language: node.language });
      } else if (
        node.language === 'csharp' &&
        node.gitStatus !== 'deleted' &&
        node.sizeBytes <= MAX_PARSABLE_CODE_FILE_BYTES
      ) {
        csNodes.push({ relativePath: node.relativePath, isTestFile: node.isTestFile });
      }
    }

    // Load any monorepo package-level `tsconfig.json` / `jsconfig.json` (sorted deepest-prefix-first)
    const scopedTsConfigs: Array<{ dirPrefix: string; config: TsConfigPathConfig }> = [];
    for (const dirRel of Array.from(nestedTsConfigDirs).sort((a, b) => b.length - a.length)) {
      const cfg = loadTsConfigPaths(guard.workspaceRoot, dirRel);
      if (cfg.baseUrlRel !== null || cfg.paths.length > 0) {
        scopedTsConfigs.push({ dirPrefix: `${dirRel}/`, config: cfg });
      }
    }
    const resolveTsConfigForFile = (relPosix: string): TsConfigPathConfig => {
      for (const scoped of scopedTsConfigs) {
        if (relPosix.startsWith(scoped.dirPrefix)) return scoped.config;
      }
      return rootTsConfig;
    };

    // Lazily build language-specific workspace indexes ONLY when files of that language exist (0ms overhead otherwise!)
    const goIndex = hasGoFiles ? buildGoWorkspaceIndex(guard.workspaceRoot, allFileSet) : null;
    const rustIndex = hasRustFiles ? buildRustWorkspaceIndex(guard.workspaceRoot, allFileSet) : null;
    const cppIncludeRoots = hasCppFiles ? collectCppIncludeRoots(allFileSet) : null;
    const jvmIndex = jvmNodes.length > 0 ? buildJvmWorkspaceIndex(guard.workspaceRoot, jvmNodes) : null;
    const csIndex = csNodes.length > 0 ? buildCSharpWorkspaceIndex(guard.workspaceRoot, csNodes) : null;

    // Compute fast topology fingerprint (file set + root & nested tsconfigs + go.mod + Cargo.toml + JVM/C# type indexes)
    // so file additions/deletions or manifest/package edits automatically invalidate stale cached edges!
    const topologyHasher = crypto.createHash('sha256');
    topologyHasher.update(JSON.stringify(rootTsConfig));
    if (scopedTsConfigs.length > 0) topologyHasher.update(JSON.stringify(scopedTsConfigs));
    if (goIndex) topologyHasher.update(`|go:${goIndex.fingerprint}`);
    if (rustIndex) topologyHasher.update(`|rs:${rustIndex.fingerprint}`);
    if (jvmIndex) topologyHasher.update(`|jvm:${jvmIndex.fingerprint}`);
    if (csIndex) topologyHasher.update(`|cs:${csIndex.fingerprint}`);
    for (const f of Array.from(allFileSet).sort()) {
      topologyHasher.update('\0');
      topologyHasher.update(f);
    }
    const topologyHash = topologyHasher.digest('hex').slice(0, 16);

    // Parse all supported mainstream code files using deterministic zero-native-addon parsers with incremental cache
    const forwardEdges = new Map<string, ParsedImportRecord[]>();
    const reverseEdges = new Map<string, ParsedImportRecord[]>();
    const allResolvedEdges: ParsedImportRecord[] = [];
    const unresolvedByFile = new Map<string, ParsedImportRecord[]>();

    let totalIndexedCodeFiles = 0;
    const cachePrefix = `${guard.workspaceRoot}::`;

    for (const node of wsSummary.files) {
      if (!isAnalyzableCodeLanguage(node.language)) {
        continue;
      }
      if (node.gitStatus === 'deleted') continue;
      if (node.sizeBytes > MAX_PARSABLE_CODE_FILE_BYTES) continue;

      totalIndexedCodeFiles++;
      const absPath = path.join(guard.workspaceRoot, node.relativePath);
      const fileMtimeMs = node.mtimeMs;
      const fileSize = node.sizeBytes;

      const cacheKey = `${cachePrefix}${node.relativePath}`;
      const cached = this.fileParseCache.get(cacheKey);
      let parsed: ParsedImportRecord[];

      if (
        cached &&
        cached.topologyHash === topologyHash &&
        fileMtimeMs > 0 &&
        cached.mtimeMs === fileMtimeMs &&
        cached.size === fileSize
      ) {
        parsed = cached.imports;
      } else {
        let srcText: string;
        try {
          srcText = fs.readFileSync(absPath, 'utf8').replace(/^\uFEFF/, '');
        } catch {
          continue;
        }
        switch (node.language) {
          case 'python':
            parsed = parsePythonImports(node.relativePath, srcText, pyFileSet, pyBasenameIndex);
            break;
          case 'sfc':
            parsed = parseSfcImports(
              node.relativePath,
              srcText,
              allFileSet,
              resolveTsConfigForFile(node.relativePath),
              caseInsensitiveFileMap,
            );
            break;
          case 'go':
            parsed = goIndex ? parseGoImports(node.relativePath, srcText, goIndex) : [];
            break;
          case 'rust':
            parsed = rustIndex ? parseRustImports(node.relativePath, srcText, rustIndex) : [];
            break;
          case 'cpp':
            parsed = cppIncludeRoots
              ? parseCppImports(node.relativePath, srcText, allFileSet, cppIncludeRoots, caseInsensitiveFileMap)
              : [];
            break;
          case 'java':
          case 'kotlin':
            parsed = jvmIndex
              ? parseJvmImports(node.relativePath, srcText, node.language, node.isTestFile, jvmIndex)
              : [];
            break;
          case 'csharp':
            parsed = csIndex ? parseCSharpImports(node.relativePath, srcText, csIndex) : [];
            break;
          default:
            parsed = parseTsJsImports(
              node.relativePath,
              srcText,
              allFileSet,
              resolveTsConfigForFile(node.relativePath),
              caseInsensitiveFileMap,
            );
            break;
        }
        if (this.fileParseCache.size >= MAX_PARSE_CACHE_ENTRIES) {
          const oldestKey = this.fileParseCache.keys().next().value;
          if (oldestKey) this.fileParseCache.delete(oldestKey);
        }
        this.fileParseCache.set(cacheKey, {
          mtimeMs: fileMtimeMs,
          size: fileSize,
          topologyHash,
          imports: parsed,
        });
      }

      forwardEdges.set(node.relativePath, parsed);
      for (const edge of parsed) {
        if (edge.targetFile && edge.targetFile !== edge.sourceFile) {
          allResolvedEdges.push(edge);
          const rev = reverseEdges.get(edge.targetFile) ?? [];
          rev.push(edge);
          reverseEdges.set(edge.targetFile, rev);
        } else if (!edge.targetFile) {
          const list = unresolvedByFile.get(edge.sourceFile) ?? [];
          list.push(edge);
          unresolvedByFile.set(edge.sourceFile, list);
        }
      }
    }

    // Determine Hop-0 changed seed files
    let seedSource: DiffImpactReport['seedSource'] = 'none';
    const seedSet = new Set<string>();

    if (options?.targetFiles && options.targetFiles.length > 0) {
      seedSource = 'explicit_targets';
      for (const rawTarget of options.targetFiles) {
        try {
          const resolved = guard.resolvePath(rawTarget);
          if (resolved.relativePath) {
            seedSet.add(resolved.relativePath);
          }
        } catch {
          // Skip invalid or out-of-workspace targets safely
        }
      }
    } else {
      const gitChanged = wsSummary.files.filter((f) => f.gitStatus !== 'clean');
      if (gitChanged.length > 0) {
        seedSource = 'git_status';
        for (const f of gitChanged) {
          seedSet.add(f.relativePath);
        }
      }
    }

    const changedFiles = Array.from(seedSet).sort();

    // Reverse BFS: Hop 1 (direct importers of changed files) -> Hop 2 (importers of Hop 1)
    const hop1Set = new Set<string>();
    const hop1Evidence = new Map<string, ParsedImportRecord>();
    for (const changed of changedFiles) {
      for (const revEdge of reverseEdges.get(changed) ?? []) {
        if (!seedSet.has(revEdge.sourceFile)) {
          hop1Set.add(revEdge.sourceFile);
          const prevEv = hop1Evidence.get(revEdge.sourceFile);
          if (!prevEv || (prevEv.confidence === 'low' && revEdge.confidence === 'high')) {
            hop1Evidence.set(revEdge.sourceFile, revEdge);
          }
        }
      }
    }

    const hop2Set = new Set<string>();
    const hop2Evidence = new Map<string, ParsedImportRecord>();
    for (const h1 of hop1Set) {
      for (const revEdge of reverseEdges.get(h1) ?? []) {
        if (!seedSet.has(revEdge.sourceFile) && !hop1Set.has(revEdge.sourceFile)) {
          hop2Set.add(revEdge.sourceFile);
          const prevEv = hop2Evidence.get(revEdge.sourceFile);
          if (!prevEv || (prevEv.confidence === 'low' && revEdge.confidence === 'high')) {
            hop2Evidence.set(revEdge.sourceFile, revEdge);
          }
        }
      }
    }

    // Upstream direct dependencies of changed files (capped so graph stays crisp in UI)
    const upstreamSet = new Set<string>();
    for (const changed of changedFiles) {
      for (const fwdEdge of forwardEdges.get(changed) ?? []) {
        if (
          fwdEdge.targetFile &&
          !seedSet.has(fwdEdge.targetFile) &&
          !hop1Set.has(fwdEdge.targetFile) &&
          !hop2Set.has(fwdEdge.targetFile)
        ) {
          upstreamSet.add(fwdEdge.targetFile);
        }
      }
    }

    // Assemble focused subgraph nodes & edges for visualization (or full workspace code graph if working tree is clean!)
    const activeNodeTiers = new Map<string, { tier: ImpactTier; hopDistance: number }>();

    if (changedFiles.length > 0) {
      for (const f of changedFiles) activeNodeTiers.set(f, { tier: 'changed', hopDistance: 0 });
      for (const f of hop1Set) activeNodeTiers.set(f, { tier: 'direct_impact', hopDistance: 1 });
      for (const f of hop2Set) activeNodeTiers.set(f, { tier: 'indirect_impact', hopDistance: 2 });
      for (const f of upstreamSet) activeNodeTiers.set(f, { tier: 'upstream_dependency', hopDistance: -1 });
    } else {
      // Clean working tree: expose core connected code files (up to 60 nodes) so Global/Aux view still shows project architecture!
      const connected = new Set<string>();
      for (const e of allResolvedEdges) {
        connected.add(e.sourceFile);
        if (e.targetFile) connected.add(e.targetFile);
      }
      for (const f of Array.from(connected).sort().slice(0, 60)) {
        activeNodeTiers.set(f, { tier: 'upstream_dependency', hopDistance: 0 });
      }
    }

    const graphNodes: ImpactGraphNode[] = [];
    for (const [relPath, tierInfo] of activeNodeTiers.entries()) {
      const meta = fileNodeMap.get(relPath);
      const absPath = path.join(guard.workspaceRoot, relPath);
      graphNodes.push({
        id: relPath,
        fileUri: meta?.fileUri ?? toFileUri(absPath),
        language: meta?.language ?? 'other',
        gitStatus: meta?.gitStatus ?? 'clean',
        isTestFile: meta?.isTestFile ?? false,
        tier: tierInfo.tier,
        hopDistance: tierInfo.hopDistance,
        inDegree: (reverseEdges.get(relPath) ?? []).length,
        outDegree: (forwardEdges.get(relPath) ?? []).filter((x) => Boolean(x.targetFile)).length,
      });
    }

    const hasAnyCodeNode = graphNodes.some((n) => isAnalyzableCodeLanguage(n.language));
    // Keep disconnected non-code files (`.md`, `.gitignore`, `.svg`, `.yml`) out of the dependency SVG
    // whenever code nodes exist so real connected code modules are never pushed off-screen!
    const filteredGraphNodes = hasAnyCodeNode
      ? graphNodes.filter((n) => n.inDegree + n.outDegree > 0 || isAnalyzableCodeLanguage(n.language))
      : graphNodes;

    // Order nodes: changed -> direct_impact -> indirect_impact -> upstream_dependency;
    // within each tier, show connected code modules (`inDegree + outDegree`) FIRST!
    const tierOrder: Record<ImpactTier, number> = {
      changed: 0,
      direct_impact: 1,
      indirect_impact: 2,
      upstream_dependency: 3,
    };
    filteredGraphNodes.sort((a, b) => {
      if (tierOrder[a.tier] !== tierOrder[b.tier]) return tierOrder[a.tier] - tierOrder[b.tier];
      const degDiff = b.inDegree + b.outDegree - (a.inDegree + a.outDegree);
      if (degDiff !== 0) return degDiff;
      return a.id.localeCompare(b.id);
    });

    const finalNodes = filteredGraphNodes.slice(0, 120);
    const finalNodeSet = new Set(finalNodes.map((n) => n.id));

    const graphEdges: ImpactGraphEdge[] = [];
    for (const e of allResolvedEdges) {
      if (!e.targetFile) continue;
      if (finalNodeSet.has(e.sourceFile) && finalNodeSet.has(e.targetFile)) {
        graphEdges.push({
          from: e.sourceFile,
          to: e.targetFile,
          line: e.line,
          specifier: e.specifier,
          snippet: e.snippet,
          kind: e.kind,
          confidence: e.confidence,
          ...(e.note ? { note: e.note } : {}),
        });
      }
    }

    // Prioritize causal blast-radius edges (`1-hop -> changed`, `2-hop -> 1-hop`) ahead of lateral context edges
    // so capping at 260 edges can NEVER starve downstream impact evidence!
    const edgeCausalPriority = (e: ImpactGraphEdge): number => {
      if (hop1Set.has(e.from) && seedSet.has(e.to)) return 0;
      if (hop2Set.has(e.from) && hop1Set.has(e.to)) return 1;
      if (seedSet.has(e.from)) return 2;
      return 3;
    };
    graphEdges.sort((a, b) => {
      const pa = edgeCausalPriority(a);
      const pb = edgeCausalPriority(b);
      if (pa !== pb) return pa - pb;
      if (a.from !== b.from) return a.from.localeCompare(b.from);
      return a.line - b.line;
    });

    // Build Recommended Test Files (Tier 1: Graph-linked tests -> Tier 2: Naming convention match)
    const recommendedTestsMap = new Map<string, RecommendedTestEntry>();
    const addRecommendedTest = (entry: RecommendedTestEntry) => {
      if (!recommendedTestsMap.has(entry.testFile)) {
        recommendedTestsMap.set(entry.testFile, entry);
      }
    };

    for (const h1 of Array.from(hop1Set).sort()) {
      const node = fileNodeMap.get(h1);
      if (node?.isTestFile) {
        const ev = hop1Evidence.get(h1);
        addRecommendedTest({
          testFile: h1,
          fileUri: node.fileUri,
          reason: 'direct_import',
          confidence: ev?.confidence ?? 'high',
          relatedChangedFile: ev?.targetFile ?? changedFiles[0] ?? '',
          evidence: ev ? `${ev.sourceFile}:${ev.line} (${ev.snippet})` : undefined,
        });
      }
    }

    for (const h2 of Array.from(hop2Set).sort()) {
      const node = fileNodeMap.get(h2);
      if (node?.isTestFile) {
        const ev = hop2Evidence.get(h2);
        const hop1Ev = ev?.targetFile ? hop1Evidence.get(ev.targetFile) : undefined;
        const rootChanged = hop1Ev?.targetFile ?? ev?.targetFile ?? changedFiles[0] ?? '';
        const chainConfidence: ImportConfidence =
          (ev?.confidence ?? 'high') === 'high' && (hop1Ev?.confidence ?? 'high') === 'high' ? 'high' : 'low';
        addRecommendedTest({
          testFile: h2,
          fileUri: node.fileUri,
          reason: 'transitive_import',
          confidence: chainConfidence,
          relatedChangedFile: rootChanged,
          evidence: ev
            ? hop1Ev?.targetFile
              ? `${ev.sourceFile}:${ev.line} via ${ev.targetFile} -> ${hop1Ev.targetFile}`
              : `${ev.sourceFile}:${ev.line} via ${ev.targetFile}`
            : undefined,
        });
      }
    }

    for (const ch of changedFiles) {
      const node = fileNodeMap.get(ch);
      if (node?.isTestFile) {
        addRecommendedTest({
          testFile: ch,
          fileUri: node.fileUri,
          reason: 'direct_import',
          confidence: 'high',
          relatedChangedFile: ch,
          evidence: 'Modified test file directly',
        });
      }
    }

    // Naming-convention test matching for changed & 1-hop modules
    const allTestNodes = wsSummary.files.filter((f) => f.isTestFile);
    const affectedModules = [...changedFiles, ...Array.from(hop1Set)];
    for (const modPath of affectedModules) {
      const modStem = normalizeStemForTestMatch(modPath);
      if (modStem.length < 3) continue;
      for (const tNode of allTestNodes) {
        if (recommendedTestsMap.has(tNode.relativePath)) continue;
        const testStem = normalizeStemForTestMatch(tNode.relativePath);
        if (testStem.length >= 3 && (testStem === modStem || testStem.includes(modStem) || modStem.includes(testStem))) {
          addRecommendedTest({
            testFile: tNode.relativePath,
            fileUri: tNode.fileUri,
            reason: 'naming_convention',
            confidence: 'low',
            relatedChangedFile: modPath,
            evidence: `Test filename stem matches impacted module "${modPath}"`,
          });
        }
      }
    }

    // Collect Low-Confidence Warnings (dynamic imports / unresolved local specifiers in changed or 1-hop files)
    const lowConfidenceWarnings: LowConfidenceWarning[] = [];
    const warningFocusFiles = changedFiles.length > 0 ? new Set([...changedFiles, ...hop1Set]) : null;
    for (const [src, edges] of forwardEdges.entries()) {
      if (warningFocusFiles && !warningFocusFiles.has(src)) continue;
      for (const e of edges) {
        if (e.confidence === 'low') {
          lowConfidenceWarnings.push({
            sourceFile: e.sourceFile,
            line: e.line,
            specifier: e.specifier,
            kind: e.kind,
            snippet: e.snippet,
            note: e.note ?? 'Dynamic or unresolved dependency — manual verification recommended.',
          });
        }
      }
    }
    for (const [src, unres] of unresolvedByFile.entries()) {
      if (warningFocusFiles && !warningFocusFiles.has(src)) continue;
      for (const e of unres) {
        if (
          !lowConfidenceWarnings.some(
            (w) => w.sourceFile === e.sourceFile && w.line === e.line && w.specifier === e.specifier,
          )
        ) {
          lowConfidenceWarnings.push({
            sourceFile: e.sourceFile,
            line: e.line,
            specifier: e.specifier,
            kind: e.kind,
            snippet: e.snippet,
            note: e.note ?? 'Unresolved import specifier.',
          });
        }
      }
    }

    const unbornGitRepo = wsSummary.isGitRepo && !wsSummary.hasInitialCommit && seedSource === 'git_status';
    const driftLimit = options?.driftThresholdFiles ?? 10;
    const touchedTopDirs = new Set(
      changedFiles
        .map((f) => (f.includes('/') ? f.split('/')[0]! : '(root)'))
        .filter((d) => d !== '(root)'),
    );
    const scopeDriftWarning = unbornGitRepo
      ? null
      : changedFiles.length > driftLimit
        ? `Scope drift notice: ${changedFiles.length} files modified across ${Math.max(1, touchedTopDirs.size)} top-level module(s) (threshold: ${driftLimit}). Consider reviewing or checkpointing before further edits.`
        : touchedTopDirs.size >= 4
          ? `Cross-module drift notice: changes span ${touchedTopDirs.size} distinct top-level directories (${Array.from(touchedTopDirs).slice(0, 5).map((d) => sanitizeUntrustedIdentifier(d, 40)).join(', ')}). Verify cross-boundary impact.`
          : null;

    const scanDurationMs = Math.round((performance.now() - t0) * 100) / 100;

    return {
      workspaceRoot: wsSummary.workspaceRoot,
      workspaceName: wsSummary.workspaceName,
      isGitRepo: wsSummary.isGitRepo,
      hasInitialCommit: wsSummary.hasInitialCommit,
      branchName: wsSummary.branchName,
      scanDurationMs,
      totalIndexedCodeFiles,
      totalGraphEdges: allResolvedEdges.length,
      seedSource,
      changedFiles,
      directImpactedFiles: Array.from(hop1Set).sort(),
      indirectImpactedFiles: Array.from(hop2Set).sort(),
      recommendedTests: Array.from(recommendedTestsMap.values()),
      lowConfidenceWarnings: lowConfidenceWarnings.slice(0, 40),
      nodes: finalNodes,
      edges: graphEdges.slice(0, 260),
      unbornGitRepo,
      scopeDriftWarning,
    };
  }
}

/**
 * Renders a concise, PR-ready, prompt-injection-safe Dual-Surface Markdown report
 * with exact `file:line` evidence and explicit High vs Low confidence separation.
 */
export function formatImpactReportMarkdown(report: DiffImpactReport): string {
  const lines: string[] = [
    `### DiffAtlas Impact Analysis — \`${sanitizeUntrustedIdentifier(report.workspaceName, 80)}\``,
    `- **Scope**: ${report.totalIndexedCodeFiles} code file(s) indexed (${report.totalGraphEdges} dependency edges) in ${report.scanDurationMs}ms`,
    `- **Blast Radius**: **${report.changedFiles.length}** changed · **${report.directImpactedFiles.length}** direct (1-hop) · **${report.indirectImpactedFiles.length}** indirect (2-hop) · **${report.recommendedTests.length}** recommended test(s)`,
  ];

  if (report.scopeDriftWarning) {
    lines.push(`- **Drift Alert**: ${report.scopeDriftWarning}`);
  }

  if (report.changedFiles.length === 0) {
    lines.push(
      '\n_No active changed files detected. Pass `targetFiles` to simulate blast radius for any module._',
    );
    return lines.join('\n');
  }

  lines.push('\n#### 1. Changed Files (Hop 0)');
  for (const f of report.changedFiles.slice(0, 25)) {
    lines.push(`- \`${sanitizeUntrustedIdentifier(f, 160)}\``);
  }

  const isCausalImpactEdge = (e: ImpactGraphEdge): boolean =>
    (report.directImpactedFiles.includes(e.from) && report.changedFiles.includes(e.to)) ||
    (report.indirectImpactedFiles.includes(e.from) && report.directImpactedFiles.includes(e.to));

  const highConfEdges = report.edges.filter((e) => e.confidence === 'high' && isCausalImpactEdge(e));
  const lowConfEdges = report.edges.filter((e) => e.confidence === 'low' && isCausalImpactEdge(e));

  if (report.directImpactedFiles.length > 0 || report.indirectImpactedFiles.length > 0) {
    lines.push('\n#### 2. Downstream Impact Evidence');
    if (highConfEdges.length > 0) {
      lines.push('**High-Confidence Static Imports:**');
      for (const e of highConfEdges.slice(0, 25)) {
        const hopTag = report.directImpactedFiles.includes(e.from) ? '1-hop' : '2-hop';
        lines.push(
          `- \`[${hopTag}]\` \`${sanitizeUntrustedIdentifier(e.from, 140)}:${e.line}\` → \`${sanitizeUntrustedIdentifier(e.to, 140)}\` (\`${sanitizeUntrustedIdentifier(e.snippet, 100)}\`)`,
        );
      }
    }
    if (lowConfEdges.length > 0) {
      lines.push('\n**Low-Confidence Dynamic / Aliased Imports (Manual Review Recommended):**');
      for (const e of lowConfEdges.slice(0, 15)) {
        lines.push(
          `- \`[LOW/${e.kind}]\` \`${sanitizeUntrustedIdentifier(e.from, 140)}:${e.line}\` → \`${sanitizeUntrustedIdentifier(e.to, 140)}\` — ${sanitizeUntrustedIdentifier(e.note ?? '', 120)}`,
        );
      }
    }
  } else {
    lines.push('\n#### 2. Downstream Impact Evidence\n_No static downstream workspace importers found for these files._');
  }

  if (report.recommendedTests.length > 0) {
    lines.push('\n#### 3. Recommended Tests');
    for (const t of report.recommendedTests.slice(0, 15)) {
      lines.push(
        `- \`[${t.confidence.toUpperCase()}/${t.reason}]\` \`${sanitizeUntrustedIdentifier(t.testFile, 140)}\`${t.evidence ? ` — ${sanitizeUntrustedIdentifier(t.evidence, 120)}` : ''}`,
      );
    }
  }

  if (report.lowConfidenceWarnings.length > 0) {
    lines.push('\n#### 4. Dynamic / Unresolved Import Warnings (Low Confidence)');
    for (const w of report.lowConfidenceWarnings.slice(0, 12)) {
      lines.push(
        `- \`${sanitizeUntrustedIdentifier(w.sourceFile, 140)}:${w.line}\` (\`${w.kind}\`) \`${sanitizeUntrustedIdentifier(w.specifier, 90)}\` — ${sanitizeUntrustedIdentifier(w.note, 120)}`,
      );
    }
  }

  return lines.join('\n');
}
