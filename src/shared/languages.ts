/**
 * Pure isomorphic language taxonomy shared between Node backend (`src/core/`)
 * and browser MCP App UI (`src/ui/`) — strictly zero `node:*` imports.
 */

export type WorkspaceFileLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'sfc'
  | 'go'
  | 'rust'
  | 'cpp'
  | 'java'
  | 'kotlin'
  | 'csharp'
  | 'json'
  | 'markdown'
  | 'other';

export const ANALYZABLE_CODE_LANGUAGES: ReadonlySet<WorkspaceFileLanguage> = new Set<WorkspaceFileLanguage>([
  'typescript',
  'javascript',
  'python',
  'sfc',
  'go',
  'rust',
  'cpp',
  'java',
  'kotlin',
  'csharp',
]);

export function isAnalyzableCodeLanguage(lang: WorkspaceFileLanguage): boolean {
  return ANALYZABLE_CODE_LANGUAGES.has(lang);
}
