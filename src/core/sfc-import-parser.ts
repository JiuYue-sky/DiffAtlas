import { sanitizeUntrustedIdentifier } from '../kit/path-guard.js';
import {
  parseTsJsImports,
  type ParsedImportRecord,
  type TsConfigPathConfig,
} from './ts-import-parser.js';

function blankPreservingNewlinesToArray(text: string): string[] {
  const out = new Array<string>(text.length);
  for (let i = 0; i < text.length; i++) {
    out[i] = text[i] === '\n' ? '\n' : ' ';
  }
  return out;
}

function maskHtmlComments(source: string): string {
  // Operate strictly on UTF-16 code units (NEVER `Array.from`), so surrogate-pair emojis inside
  // `<!-- 🚀 -->` comments preserve exact UTF-16 offsets relative to `source`!
  const chars = new Array<string>(source.length);
  let i = 0;
  while (i < source.length) {
    if (
      source[i] === '<' &&
      source[i + 1] === '!' &&
      source[i + 2] === '-' &&
      source[i + 3] === '-'
    ) {
      let j = i + 4;
      while (j < source.length) {
        if (source[j] === '-' && source[j + 1] === '-' && source[j + 2] === '>') {
          j += 3;
          break;
        }
        j++;
      }
      for (let k = i; k < j && k < source.length; k++) {
        chars[k] = source[k] === '\n' ? '\n' : ' ';
      }
      i = j;
      continue;
    }
    chars[i] = source[i]!;
    i++;
  }
  return chars.join('');
}

function offsetToLine(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Deterministic zero-native-addon parser for Vue (`.vue`), Svelte (`.svelte`), and Astro (`.astro`) SFCs.
 * Preserves exact 1-based line numbers by blanking template/style/HTML-comment regions and delegating
 * extracted `<script>` / frontmatter blocks directly to `parseTsJsImports`.
 */
export function parseSfcImports(
  sourceFilePosix: string,
  rawSourceText: string,
  allFileSet: ReadonlySet<string>,
  tsConfig: TsConfigPathConfig,
  caseInsensitiveMap?: ReadonlyMap<string, string>,
): ParsedImportRecord[] {
  const sourceText = rawSourceText.replace(/^\uFEFF/, '');
  const lower = sourceFilePosix.toLowerCase();
  let maskedHtml = maskHtmlComments(sourceText);
  const lines = sourceText.split(/\r?\n/);

  // Start with an all-spaces UTF-16 buffer preserving every `\n`, then copy ONLY script/frontmatter slices into place
  const scriptChars = blankPreservingNewlinesToArray(sourceText);
  const extraSrcSpecifiers: Array<{ specifier: string; line: number }> = [];

  if (lower.endsWith('.astro')) {
    // Astro frontmatter: leading `---` ... `---` fence
    const fmMatch = /^[ \t]*---[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*---(?:[ \t]*(?:\r?\n|$))/.exec(sourceText);
    if (fmMatch && fmMatch[1] !== undefined) {
      const firstNl = fmMatch[0].indexOf('\n');
      const contentStart = firstNl === -1 ? 0 : firstNl + 1;
      for (let k = 0; k < fmMatch[1].length; k++) {
        scriptChars[contentStart + k] = sourceText[contentStart + k]!;
      }
      // Blank frontmatter in `maskedHtml` so string literals like `'<script>import "./fake"</script>'`
      // inside Astro frontmatter cannot trigger a secondary `<script>` regex match!
      const blankFm = blankPreservingNewlinesToArray(fmMatch[0]).join('');
      maskedHtml = blankFm + maskedHtml.slice(fmMatch[0].length);
    }
  }

  // Extract all `<script ...>...</script>` blocks while handling `>` inside quoted attributes
  // (e.g. Vue 3.3+ `<script setup lang="ts" generic="T extends Record<string, unknown>">`)!
  const scriptTagRe = /<script\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/script\s*>/gi;
  for (const m of maskedHtml.matchAll(scriptTagRe)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const tagStart = m.index ?? 0;

    // Skip non-executable data scripts such as `<script type="application/ld+json">` or `<script type="importmap">`
    const typeAttr = /\btype\s*=\s*(['"])([^'"]+)\1/i.exec(attrs);
    if (typeAttr?.[2]) {
      const mime = typeAttr[2].trim().toLowerCase();
      const isJsOrTs =
        mime === 'module' ||
        mime === 'text/javascript' ||
        mime === 'application/javascript' ||
        mime === 'text/typescript' ||
        mime === 'application/typescript' ||
        mime === 'ts';
      if (!isJsOrTs) continue;
    }

    // External `<script src="./logic.ts"></script>`
    const srcAttr = /\bsrc\s*=\s*(['"])([^'"]+)\1/i.exec(attrs);
    if (srcAttr?.[2]) {
      extraSrcSpecifiers.push({
        specifier: srcAttr[2].trim(),
        line: offsetToLine(sourceText, tagStart),
      });
    }

    const openTagEnd = '<script'.length + attrs.length + 1;
    const bodyStart = tagStart + openTagEnd;
    for (let k = 0; k < body.length; k++) {
      scriptChars[bodyStart + k] = sourceText[bodyStart + k]!;
    }
  }

  const syntheticTs = scriptChars.join('');
  const results = parseTsJsImports(sourceFilePosix, syntheticTs, allFileSet, tsConfig, caseInsensitiveMap);

  // Resolve any external `<script src="...">` attributes via synthetic import statement
  for (const extSrc of extraSrcSpecifiers) {
    const synth = `import '${extSrc.specifier.replace(/'/g, '')}';`;
    const parsed = parseTsJsImports(sourceFilePosix, synth, allFileSet, tsConfig, caseInsensitiveMap);
    for (const rec of parsed) {
      results.push({
        ...rec,
        line: extSrc.line,
        snippet: sanitizeUntrustedIdentifier((lines[extSrc.line - 1] ?? '').trim(), 140),
      });
    }
  }

  return results;
}
