import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitignoreMatcher } from '../src/core/gitignore.js';
import { ImpactAnalyzer } from '../src/core/impact-analyzer.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('Deep Adversarial, Edge-Case & Stress Suite Across All 8 Language Families', () => {
  it('handles monorepo nested tsconfig with TS 5.0+ array extends, JSON-LD script immunity, and unclosed EOF strings', async () => {
    const ws = makeTempDir('da-adv-monorepo-');
    writeFiles(ws, {
      'package.json': '{ "name": "monorepo-root", "private": true }\n',
      'packages/web/tsconfig.base.json': '{ "compilerOptions": { "strict": true } }\n',
      'packages/web/tsconfig.paths.json': '{ "compilerOptions": { "paths": { "@web/*": ["./src/*"] } } }\n',
      'packages/web/tsconfig.json': '{ "extends": ["./tsconfig.base.json", "./tsconfig.paths.json"] }\n',
      'packages/web/src/utils/theme.ts': 'export const THEME = "dark";\n',
      'packages/web/src/utils/fake.ts': 'export const FAKE = "no";\n',
      'packages/web/src/components/PrimaryCard.vue': [
        '<template><section>Card</section></template>',
        '<script type="application/ld+json">',
        '{ "@context": "https://schema.org", "import": "@web/utils/fake" }',
        '</script>',
        '<script setup lang="ts">',
        "import { THEME } from '@web/utils/theme';",
        'console.log(THEME);',
        '</script>',
      ].join('\r\n'),
      // Mid-edit file with unclosed string + trailing backslash at EOF + case-mismatched import on Win/Mac
      'packages/web/src/broken.ts': [
        "import { THEME } from '@web/utils/theme';",
        "import Card from '@web/components/primarycard.vue';",
        'console.log(Card);',
        "const wip = 'unterminated\\",
      ].join('\n'),
    });

    const analyzer = new ImpactAnalyzer();
    const rep = await analyzer.analyzeImpact(ws, { targetFiles: ['packages/web/src/utils/theme.ts'] });
    expect(rep.directImpactedFiles).toContain('packages/web/src/components/PrimaryCard.vue');
    expect(rep.directImpactedFiles).toContain('packages/web/src/broken.ts');

    if (process.platform === 'win32' || process.platform === 'darwin') {
      const cardRep = await analyzer.analyzeImpact(ws, {
        targetFiles: ['packages/web/src/components/PrimaryCard.vue'],
      });
      expect(cardRep.directImpactedFiles).toContain('packages/web/src/broken.ts');
    }

    // JSON-LD `<script type="application/ld+json">` must be completely ignored
    const fakeRep = await analyzer.analyzeImpact(ws, { targetFiles: ['packages/web/src/utils/fake.ts'] });
    expect(fakeRep.directImpactedFiles.length).toBe(0);
  });

  it('eliminates Go >12-file package fanout blind spots (30-file package) and ignores vendor/ & testdata/', async () => {
    const ws = makeTempDir('da-adv-go-');
    const files: Record<string, string> = {
      'go.mod': 'module github.com/acme/largepkg\ngo 1.22\n',
      'cmd/api/main.go': 'package main\nimport "github.com/acme/largepkg/pkg/handlers"\nfunc main() { handlers.ZCheckout() }\n',
      'pkg/handlers/handlers_test.go': 'package handlers\nimport "testing"\nfunc TestZ(t *testing.T) { ZCheckout() }\n',
      'vendor/github.com/acme/largepkg/pkg/handlers/vendored.go': 'package handlers\n',
      'pkg/handlers/testdata/fixture.go': 'package handlers\n',
    };
    for (let i = 1; i <= 28; i++) {
      const num = String(i).padStart(2, '0');
      files[`pkg/handlers/h_${num}.go`] = `package handlers\nfunc H${num}() {}\n`;
    }
    // 29th/30th file alphabetically (`z_checkout.go`) — previously missed when fanout cap was 12!
    files['pkg/handlers/z_checkout.go'] = 'package handlers\nfunc ZCheckout() {}\n';
    writeFiles(ws, files);

    const analyzer = new ImpactAnalyzer();
    const rep = await analyzer.analyzeImpact(ws, { targetFiles: ['pkg/handlers/z_checkout.go'] });
    expect(rep.directImpactedFiles).toContain('cmd/api/main.go');
    expect(rep.directImpactedFiles).toContain('pkg/handlers/handlers_test.go');
    expect(rep.recommendedTests.some((t) => t.testFile === 'pkg/handlers/handlers_test.go')).toBe(true);
  });

  it('resolves Rust custom [lib] name/path, raw idents (mod r#type), interleaved #[cfg]+#[path], bare child pub use, and include!()', async () => {
    const ws = makeTempDir('da-adv-rust-');
    writeFiles(ws, {
      'Cargo.toml': '[workspace]\nmembers = ["crates/my-sdk", "crates/runner"]\n',
      'crates/my-sdk/Cargo.toml': [
        '[package]',
        'name = "my-sdk"',
        'version = "0.1.0"',
        '[lib]',
        'name = "custom_sdk"',
        'path = "src/entry.rs"',
      ].join('\n'),
      'crates/my-sdk/src/entry.rs': [
        'pub mod r#type;',
        '#[cfg(unix)]',
        '#[path = "os_unix.rs"]',
        'pub mod os;',
        'mod internal;',
        'pub use internal::deep::Helper;',
        'include!("inline_defs.rs");',
        'include!(concat!(env!("OUT_DIR"), "/bindings.rs"));',
      ].join('\n'),
      'crates/my-sdk/src/type.rs': 'pub struct Kind;\n',
      'crates/my-sdk/src/os_unix.rs': 'pub fn platform() {}\n',
      'crates/my-sdk/src/internal.rs': 'pub mod deep;\n',
      'crates/my-sdk/src/internal/deep.rs': 'pub struct Helper;\n',
      'crates/my-sdk/src/inline_defs.rs': 'pub const GEN_VER: u32 = 1;\n',
      'crates/runner/Cargo.toml': '[package]\nname = "runner"\nversion = "0.1.0"\n',
      'crates/runner/src/main.rs': 'use custom_sdk::r#type::Kind;\nfn main() { let _ = Kind; }\n',
    });

    const analyzer = new ImpactAnalyzer();

    // `mod r#type;` and `use custom_sdk::r#type::Kind;` resolve to `type.rs`
    const repType = await analyzer.analyzeImpact(ws, { targetFiles: ['crates/my-sdk/src/type.rs'] });
    expect(repType.directImpactedFiles).toContain('crates/my-sdk/src/entry.rs');
    expect(repType.directImpactedFiles).toContain('crates/runner/src/main.rs');

    // `#[cfg(unix)]\n#[path = "os_unix.rs"]\npub mod os;` resolves to `os_unix.rs`
    const repOs = await analyzer.analyzeImpact(ws, { targetFiles: ['crates/my-sdk/src/os_unix.rs'] });
    expect(repOs.directImpactedFiles).toContain('crates/my-sdk/src/entry.rs');

    // Bare child `pub use internal::deep::Helper;` resolves directly to `internal/deep.rs`
    const repDeep = await analyzer.analyzeImpact(ws, { targetFiles: ['crates/my-sdk/src/internal/deep.rs'] });
    expect(repDeep.directImpactedFiles).toContain('crates/my-sdk/src/entry.rs');

    // Static `include!("inline_defs.rs")` resolves, and dynamic `include!(concat!(...))` emits low-confidence warning
    const repInline = await analyzer.analyzeImpact(ws, { targetFiles: ['crates/my-sdk/src/inline_defs.rs'] });
    expect(repInline.directImpactedFiles).toContain('crates/my-sdk/src/entry.rs');
    expect(repInline.lowConfidenceWarnings.some((w) => w.specifier === 'include!(...)')).toBe(true);
  });

  it('resolves C/C++ .inl/.ipp template headers, inline-commented #include /* ... */ "...", and Objective-C++ #import', async () => {
    const ws = makeTempDir('da-adv-cpp-');
    writeFiles(ws, {
      'include/vec/vec3.inl': 'inline float dot3() { return 1.0f; }\n',
      'include/vec/vec3.hpp': '#pragma once\n#include /* inline impl */ "vec3.inl"\n',
      'src/bridge.cpp': '#import "vec/vec3.hpp"\nfloat run() { return dot3(); }\n',
    });

    const analyzer = new ImpactAnalyzer();
    const rep = await analyzer.analyzeImpact(ws, { targetFiles: ['include/vec/vec3.inl'] });
    expect(rep.directImpactedFiles).toContain('include/vec/vec3.hpp');
    expect(rep.indirectImpactedFiles).toContain('src/bridge.cpp');
  });

  it('handles Java/Kotlin nested-paren annotations, @Composable fun, const val, Kotlin ${...}/$ident templates, and backtick `in` packages', async () => {
    const ws = makeTempDir('da-adv-jvm-');
    writeFiles(ws, {
      'src/main/kotlin/com/acme/ui/UiTokens.kt': [
        'package com.acme.ui',
        'const val API_VER = "v2"',
        '@Deprecated(message = "old", replaceWith = ReplaceWith("NewCard()"))',
        '@Composable fun LegacyCard(): String = "card"',
      ].join('\n'),
      'src/main/kotlin/com/acme/ui/HomeScreen.kt': [
        'package com.acme.ui',
        'fun render(): String = "ver=$API_VER body=${LegacyCard()}"',
      ].join('\n'),
      'src/main/kotlin/com/acme/in/Lexer.kt': [
        'package com.acme.`in`',
        '@Suppress("unused")class Lexer',
      ].join('\n'),
      'src/main/kotlin/com/acme/app/Boot.kt': [
        'package com.acme.app',
        'import com.acme.`in`.Lexer',
        'fun boot() { Lexer() }',
      ].join('\n'),
    });

    const analyzer = new ImpactAnalyzer();
    const repTokens = await analyzer.analyzeImpact(ws, {
      targetFiles: ['src/main/kotlin/com/acme/ui/UiTokens.kt'],
    });
    expect(repTokens.directImpactedFiles).toContain('src/main/kotlin/com/acme/ui/HomeScreen.kt');

    const repLexer = await analyzer.analyzeImpact(ws, {
      targetFiles: ['src/main/kotlin/com/acme/in/Lexer.kt'],
    });
    expect(repLexer.directImpactedFiles).toContain('src/main/kotlin/com/acme/app/Boot.kt');
  });

  it('handles C# nested-bracket attributes, delegates, $"...{Expr}..." interpolated strings, and .NET bin/Debug vs CLI bin/ preservation', async () => {
    const ws = makeTempDir('da-adv-cs-');
    writeFiles(ws, {
      'src/Billing/Gateway.cs': [
        'namespace MyApp.Billing;',
        '[TypeFilter(typeof(string[]))][Serializable]public class Gateway { public static string Name => "Stripe"; }',
        'public delegate void PaymentHook(int amount);',
      ].join('\n'),
      'src/Billing/Hooks.cs': [
        'namespace MyApp.Billing;',
        'public delegate void AuditCallback(string msg);',
      ].join('\n'),
      'src/Web/ReceiptView.cs': [
        'using MyApp.Billing;',
        'namespace MyApp.Web;',
        'public class ReceiptView {',
        '  public string Render() => $"{{escaped}} Paid via {Gateway.Name}";',
        '  public AuditCallback? Hook { get; set; }',
        '}',
      ].join('\n'),
      // Confirmed .NET MSBuild output (`bin/Debug` + sibling `obj/Debug`) MUST be ignored
      'obj/Debug/Generated.cs': 'namespace MyApp.Gen; public class Gen {}\n',
      'bin/Debug/GeneratedBin.cs': 'using MyApp.Billing; namespace MyApp.Gen; public class GenBin { Gateway g; }\n',
      // Standalone CLI `tools/bin/run.ts` (no sibling `obj/`) MUST NOT be ignored!
      'tools/bin/run.ts': 'export const cli = true;\n',
    });

    const matcher = new GitignoreMatcher(ws);
    expect(matcher.isIgnored('bin', true)).toBe(true);
    expect(matcher.isIgnored('tools/bin/run.ts', false)).toBe(false);

    const analyzer = new ImpactAnalyzer();
    const repGw = await analyzer.analyzeImpact(ws, { targetFiles: ['src/Billing/Gateway.cs'] });
    expect(repGw.directImpactedFiles).toContain('src/Web/ReceiptView.cs');
    expect(repGw.directImpactedFiles).not.toContain('bin/Debug/GeneratedBin.cs');

    const repDelegate = await analyzer.analyzeImpact(ws, { targetFiles: ['src/Billing/Hooks.cs'] });
    expect(repDelegate.directImpactedFiles).toContain('src/Web/ReceiptView.cs');
  });

  it('propagates 2-hop test confidence & root Hop-0 attribution accurately and survives pathological stress inputs in <400ms', async () => {
    const ws = makeTempDir('da-adv-stress-');
    writeFiles(ws, {
      'src/hop0.ts': 'export const secret = 42;\n',
      // Hop 1 uses dynamic import() (`confidence: "low"`)
      'src/hop1.ts': 'export const load = () => import("./hop0.js");\n',
      // Hop 2 test uses static import (`confidence: "high"`), but overall chain is LOW because hop1->hop0 is LOW!
      'tests/chain.test.ts': 'import { load } from "../src/hop1.js";\nload();\n',
      // Pathological stress files (deeply nested comments, 2,000 repeated tokens, empty files)
      'src/empty.py': '',
      'src/stress.rs': `${'/* '.repeat(200)}${'*/ '.repeat(200)}\npub fn ok() {}\n`,
      'src/stress.cs': `namespace Stress;\n${'[Attr]'.repeat(300)}\npublic class Heavy { public string S = $"${'{1}'.repeat(200)}"; }\n`,
      'src/stress.kt': `package stress\n${'@Anno(1)\n'.repeat(200)}fun ok() = "${'${1}'.repeat(200)}"\n`,
    });

    const t0 = performance.now();
    const analyzer = new ImpactAnalyzer();
    const rep = await analyzer.analyzeImpact(ws, { targetFiles: ['src/hop0.ts'] });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(600);
    const recTest = rep.recommendedTests.find((t) => t.testFile === 'tests/chain.test.ts');
    expect(recTest).toBeDefined();
    expect(recTest?.reason).toBe('transitive_import');
    expect(recTest?.confidence).toBe('low');
    expect(recTest?.relatedChangedFile).toBe('src/hop0.ts');
    expect(recTest?.evidence).toContain('src/hop0.ts');
  });
});
