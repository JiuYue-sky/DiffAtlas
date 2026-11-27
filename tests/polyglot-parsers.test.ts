import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ImpactAnalyzer, formatImpactReportMarkdown } from '../src/core/impact-analyzer.js';
import { GitignoreMatcher } from '../src/core/gitignore.js';

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

describe('Polyglot Mainstream Parsers (Positive, Negative, Line Accuracy & Cache Soundness)', () => {
  it('parses Vue, Svelte, and Astro SFCs with exact line numbers, tsconfig aliases, and HTML comment immunity', async () => {
    const ws = makeTempDir('da-sfc-');
    writeFiles(ws, {
      'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
      'src/utils/format.ts': 'export const fmt = (s: string) => s.trim();\n',
      'src/utils/fake.ts': 'export const FAKE = 1;\n',
      'src/logic/ext.ts': 'export const ext = 2;\n',
      'src/components/Button.vue': [
        '<template>',
        '  <!-- <script>import { FAKE } from "../utils/fake.ts";</script> -->',
        '  <button>{{ label }}</button>',
        '</template>',
        '<script setup lang="ts" generic="T extends Record<string, unknown>">',
        "import { fmt } from '@/utils/format';",
        'const label = fmt("hi");',
        '</script>',
      ].join('\n'),
      'src/pages/Home.svelte': [
        '<script context="module" lang="ts">',
        "export { fmt } from '../utils/format';",
        '</script>',
        '<script src="../logic/ext.ts"></script>',
        '<script lang="ts">',
        "import Button from '../components/Button.vue';",
        'console.log(Button);',
        '</script>',
        '<main />',
      ].join('\n'),
      'src/pages/Index.astro': [
        '---',
        "import { fmt } from '../utils/format';",
        'const title = fmt("Astro");',
        '---',
        '<h1>{title}</h1>',
      ].join('\n'),
      'tests/format.test.ts': "import { fmt } from '../src/utils/format.js';\nfmt('a');\n",
    });

    const analyzer = new ImpactAnalyzer();
    const report = await analyzer.analyzeImpact(ws, { targetFiles: ['src/utils/format.ts'] });

    expect(report.directImpactedFiles).toContain('src/components/Button.vue');
    expect(report.directImpactedFiles).toContain('src/pages/Home.svelte');
    expect(report.directImpactedFiles).toContain('src/pages/Index.astro');
    expect(report.directImpactedFiles).toContain('tests/format.test.ts');
    expect(report.recommendedTests.some((t) => t.testFile === 'tests/format.test.ts')).toBe(true);

    // Exact 1-based line number check inside Vue `<script setup>` (line 6!)
    const vueEdge = report.edges.find(
      (e) => e.from === 'src/components/Button.vue' && e.to === 'src/utils/format.ts',
    );
    expect(vueEdge?.line).toBe(6);
    expect(vueEdge?.confidence).toBe('high');

    // External `<script src="../logic/ext.ts">` resolves cleanly
    const extReport = await analyzer.analyzeImpact(ws, { targetFiles: ['src/logic/ext.ts'] });
    expect(extReport.directImpactedFiles).toContain('src/pages/Home.svelte');

    // HTML-commented fake `<script>` MUST produce zero edges!
    const fakeReport = await analyzer.analyzeImpact(ws, { targetFiles: ['src/utils/fake.ts'] });
    expect(fakeReport.directImpactedFiles.length).toBe(0);
  });

  it('parses Go modules, replace directives, same-package _test.go, raw strings, plugin.Open, and invalidates on go.mod edits', async () => {
    const ws = makeTempDir('da-go-');
    writeFiles(ws, {
      'go.mod': [
        'module github.com/acme/demo',
        '',
        'go 1.22',
        '',
        'replace github.com/acme/shared => ./libs/shared',
      ].join('\n'),
      'libs/shared/id.go': 'package shared\nfunc NewID() string { return "1" }\n',
      'pkg/auth/auth.go': [
        'package auth',
        'import (',
        '  "fmt"',
        '  sh "github.com/acme/shared"',
        ')',
        'var doc = `import "github.com/acme/demo/pkg/fake"`',
        'func Auth() string { return fmt.Sprint(sh.NewID(), doc) }',
      ].join('\n'),
      'pkg/auth/token.go': 'package auth\nfunc Sign() string { return Auth() }\n',
      'pkg/auth/auth_test.go': 'package auth\nimport "testing"\nfunc TestSign(t *testing.T) { _ = Sign() }\n',
      'pkg/fake/fake.go': 'package fake\nfunc Nope() {}\n',
      'cmd/app/main.go': [
        'package main',
        'import (',
        '  "plugin"',
        '  "github.com/acme/demo/pkg/auth"',
        ')',
        'func main() { _, _ = plugin.Open("ext.so"); _ = auth.Sign() }',
      ].join('\n'),
    });

    const analyzer = new ImpactAnalyzer();
    const repToken = await analyzer.analyzeImpact(ws, { targetFiles: ['pkg/auth/token.go'] });
    expect(repToken.directImpactedFiles).toContain('cmd/app/main.go');
    expect(repToken.directImpactedFiles).toContain('pkg/auth/auth_test.go');
    expect(repToken.recommendedTests.some((t) => t.testFile === 'pkg/auth/auth_test.go')).toBe(true);

    // Local `replace` directive maps `github.com/acme/shared` -> `libs/shared/id.go`
    const repShared = await analyzer.analyzeImpact(ws, { targetFiles: ['libs/shared/id.go'] });
    expect(repShared.directImpactedFiles).toContain('pkg/auth/auth.go');

    // `plugin.Open` flagged as low-confidence dynamic warning
    const repMain = await analyzer.analyzeImpact(ws, { targetFiles: ['cmd/app/main.go'] });
    expect(repMain.lowConfidenceWarnings.some((w) => w.specifier === 'plugin.Open')).toBe(true);

    // Raw backtick string MUST NOT create false edge to `pkg/fake/fake.go`
    const repFake = await analyzer.analyzeImpact(ws, { targetFiles: ['pkg/fake/fake.go'] });
    expect(repFake.directImpactedFiles.length).toBe(0);

    // Mutating `go.mod` module path invalidates cached Go edges cleanly
    fs.writeFileSync(path.join(ws, 'go.mod'), 'module github.com/acme/renamed\ngo 1.22\n', 'utf8');
    const repAfterModRename = await analyzer.analyzeImpact(ws, { targetFiles: ['pkg/auth/token.go'] });
    expect(repAfterModRename.directImpactedFiles).not.toContain('cmd/app/main.go');
  });

  it('parses Rust workspaces (hyphen->underscore crate names), mod/use/super trees, lifetimes, nested comments, and skips target/debug', async () => {
    const ws = makeTempDir('da-rust-');
    writeFiles(ws, {
      'Cargo.toml': '[workspace]\nmembers = ["crates/core-lib", "crates/cli-app"]\n',
      'crates/core-lib/Cargo.toml': '[package]\nname = "core-lib"\nversion = "0.1.0"\n',
      'crates/core-lib/src/lib.rs': [
        'pub mod net;',
        'pub struct RootConfig;',
        '/* outer /* nested use crate::fake; */ still comment */',
        'pub fn borrow<\'a>(x: &\'a str) -> &\'a str { x }',
        'pub const RAW: &str = r#"use crate::fake;"#;',
      ].join('\n'),
      'crates/core-lib/src/net.rs': [
        'pub mod client;',
        'use super::RootConfig;',
        'pub fn init(_: RootConfig) {}',
      ].join('\n'),
      'crates/core-lib/src/net/client.rs': 'pub struct HttpClient;\n',
      'crates/core-lib/src/fake.rs': 'pub struct Fake;\n',
      'crates/core-lib/tests/integration_test.rs': 'use core_lib::net::client::HttpClient;\n#[test] fn ok() { let _ = HttpClient; }\n',
      'crates/cli-app/Cargo.toml': '[package]\nname = "cli-app"\nversion = "0.1.0"\n',
      'crates/cli-app/src/main.rs': [
        '#[allow(unused)] use core_lib::net::{self, client::HttpClient};',
        'fn main() { let _ = HttpClient; }',
      ].join('\n'),
      // Confirmed Cargo build artifact folder MUST be ignored, while `src/target/keep.rs` is preserved!
      'target/CACHEDIR.TAG': 'Signature: 8a477f597d28d172789f06886806bc55\n',
      'target/debug/generated.rs': 'use core_lib::net::client::HttpClient;\n',
      'src/target/keep.rs': 'pub fn kept() {}\n',
    });

    const matcher = new GitignoreMatcher(ws);
    expect(matcher.isIgnored('target', true)).toBe(true);
    expect(matcher.isIgnored('src/target/keep.rs', false)).toBe(false);

    const analyzer = new ImpactAnalyzer();
    const repClient = await analyzer.analyzeImpact(ws, {
      targetFiles: ['crates/core-lib/src/net/client.rs'],
    });
    expect(repClient.directImpactedFiles).toContain('crates/core-lib/src/net.rs');
    expect(repClient.directImpactedFiles).toContain('crates/cli-app/src/main.rs');
    expect(repClient.directImpactedFiles).toContain('crates/core-lib/tests/integration_test.rs');
    expect(repClient.directImpactedFiles).not.toContain('target/debug/generated.rs');
    expect(repClient.recommendedTests.some((t) => t.testFile === 'crates/core-lib/tests/integration_test.rs')).toBe(true);

    // `use super::RootConfig` in `net.rs` resolves back to `src/lib.rs`
    const repLib = await analyzer.analyzeImpact(ws, { targetFiles: ['crates/core-lib/src/lib.rs'] });
    expect(repLib.directImpactedFiles).toContain('crates/core-lib/src/net.rs');

    // Nested block comment + raw string + lifetime `'a` MUST produce zero false edges to `fake.rs`!
    const repFake = await analyzer.analyzeImpact(ws, { targetFiles: ['crates/core-lib/src/fake.rs'] });
    expect(repFake.directImpactedFiles.length).toBe(0);
  });

  it('parses C/C++ quoted & workspace angle-bracket includes, raw strings, dlopen warnings, and test recommendations', async () => {
    const ws = makeTempDir('da-cpp-');
    writeFiles(ws, {
      'include/mylib/math.hpp': '#pragma once\nint add(int a, int b);\n',
      'include/mylib/fake.hpp': '#pragma once\nint fake();\n',
      'src/math.cpp': [
        '#include <vector>',
        '#include <mylib/math.hpp>',
        'const char* raw = R"doc(#include "mylib/fake.hpp")doc";',
        'const char* multi = "hello\\n\\',
        '#include \\"mylib/fake.hpp\\"";',
        'int add(int a, int b) { return a + b; }',
      ].join('\n'),
      'src/engine.cpp': [
        '\uFEFF#include "mylib/math.hpp"',
        '#include <dlfcn.h>',
        "char quote = '\"'; int million = 1'000'000;",
        'void load() { dlopen("mod.so", 1); add(1, 2); }',
      ].join('\n'),
      'tests/math_test.cpp': '#include "mylib/math.hpp"\nint main() { return add(1, 1) - 2; }\n',
    });

    const analyzer = new ImpactAnalyzer();
    const rep = await analyzer.analyzeImpact(ws, { targetFiles: ['include/mylib/math.hpp'] });
    expect(rep.directImpactedFiles).toContain('src/math.cpp');
    expect(rep.directImpactedFiles).toContain('src/engine.cpp');
    expect(rep.directImpactedFiles).toContain('tests/math_test.cpp');
    expect(rep.recommendedTests.some((t) => t.testFile === 'tests/math_test.cpp')).toBe(true);
    expect(rep.lowConfidenceWarnings.some((w) => w.specifier === 'dlopen')).toBe(true);

    const fakeRep = await analyzer.analyzeImpact(ws, { targetFiles: ['include/mylib/fake.hpp'] });
    expect(fakeRep.directImpactedFiles.length).toBe(0);
  });

  it('parses Java & Kotlin explicit/static/wildcard/same-package imports, text blocks, and Class.forName warnings', async () => {
    const ws = makeTempDir('da-jvm-');
    writeFiles(ws, {
      'src/main/java/com/acme/auth/TokenService.java': [
        'package com.acme.auth;',
        'public class TokenService {',
        '  public static final String ALG = "HS256";',
        '  String block = """',
        '    import com.acme.auth.FakeClass;',
        '  """;',
        '}',
      ].join('\n'),
      'src/main/java/com/acme/auth/FakeClass.java': 'package com.acme.auth;\npublic class FakeClass {}\n',
      'src/main/java/com/acme/auth/AuthController.java': [
        'package com.acme.auth;',
        '// Same package reference without explicit import!',
        'public class AuthController { TokenService svc; }',
      ].join('\n'),
      'src/main/kotlin/com/acme/app/Router.kt': [
        'package com.acme.app',
        'import com.acme.auth.TokenService as TS',
        '/* outer /* nested import com.acme.auth.FakeClass */ end */',
        'fun route(t: TS) { Class.forName("com.acme.Dynamic") }',
      ].join('\n'),
      'src/main/java/com/acme/app/WildcardConsumer.java': [
        'package com.acme.app;',
        'import com.acme.auth.*;',
        'public class WildcardConsumer {}',
      ].join('\n'),
      'src/test/java/com/acme/auth/TokenServiceTest.java': [
        'package com.acme.auth;',
        'public class TokenServiceTest { TokenService s = new TokenService(); }',
      ].join('\n'),
    });

    const analyzer = new ImpactAnalyzer();
    const rep = await analyzer.analyzeImpact(ws, {
      targetFiles: ['src/main/java/com/acme/auth/TokenService.java'],
    });
    expect(rep.directImpactedFiles).toContain('src/main/java/com/acme/auth/AuthController.java');
    expect(rep.directImpactedFiles).toContain('src/main/kotlin/com/acme/app/Router.kt');
    expect(rep.directImpactedFiles).toContain('src/test/java/com/acme/auth/TokenServiceTest.java');
    expect(rep.recommendedTests.some((t) => t.testFile === 'src/test/java/com/acme/auth/TokenServiceTest.java')).toBe(true);

    // Wildcard `import com.acme.auth.*;` MUST be flagged LOW confidence (honest uncertainty!)
    const wildcardEdge = rep.edges.find(
      (e) => e.from === 'src/main/java/com/acme/app/WildcardConsumer.java',
    );
    expect(wildcardEdge?.confidence).toBe('low');

    // Kotlin `Class.forName` flagged as low-confidence warning
    expect(rep.lowConfidenceWarnings.some((w) => w.specifier === 'Class.forName')).toBe(true);

    // Triple-quoted text block & Kotlin nested comment MUST NOT match `FakeClass` (except WildcardConsumer)
    const fakeRep = await analyzer.analyzeImpact(ws, {
      targetFiles: ['src/main/java/com/acme/auth/FakeClass.java'],
    });
    expect(fakeRep.directImpactedFiles).not.toContain('src/main/java/com/acme/auth/TokenService.java');
    expect(fakeRep.directImpactedFiles).not.toContain('src/main/kotlin/com/acme/app/Router.kt');
  });

  it('parses C# namespaces with type-filtered precision, verbatim/raw string immunity, Assembly.Load warnings, and obj/ ignore', async () => {
    const ws = makeTempDir('da-csharp-');
    writeFiles(ws, {
      'src/Services/PaymentService.cs': 'namespace MyApp.Services;\npublic class PaymentService { public void Pay() {} }\n',
      'src/Services/EmailService.cs': 'namespace MyApp.Services;\npublic class EmailService { public void Send() {} }\n',
      'src/Services/FakeService.cs': 'namespace MyApp.Fake;\npublic class FakeService {}\n',
      'src/Web/OrderController.cs': [
        'using System;',
        'using MyApp.Services;',
        'namespace MyApp.Web {',
        '  public class OrderController {',
        '    private readonly string s = @"using MyApp.Fake;";',
        '    public void Run() { using var pay = new PaymentService(); pay.Pay(); System.Reflection.Assembly.Load("Dyn"); }',
        '  }',
        '}',
      ].join('\n'),
      'tests/MyApp.Tests/PaymentServiceTests.cs': [
        'using MyApp.Services;',
        'namespace MyApp.Tests;',
        'public class PaymentServiceTests { public void Test() { new PaymentService().Pay(); } }',
      ].join('\n'),
      'obj/Debug/Generated.cs': 'using MyApp.Services;\npublic class Gen { PaymentService p; }\n',
    });

    const analyzer = new ImpactAnalyzer();
    const repPay = await analyzer.analyzeImpact(ws, { targetFiles: ['src/Services/PaymentService.cs'] });
    expect(repPay.directImpactedFiles).toContain('src/Web/OrderController.cs');
    expect(repPay.directImpactedFiles).toContain('tests/MyApp.Tests/PaymentServiceTests.cs');
    expect(repPay.directImpactedFiles).not.toContain('obj/Debug/Generated.cs');
    expect(repPay.recommendedTests.some((t) => t.testFile === 'tests/MyApp.Tests/PaymentServiceTests.cs')).toBe(true);

    // High-precision type filtering: `OrderController.cs` mentions `PaymentService`, NOT `EmailService`!
    const repEmail = await analyzer.analyzeImpact(ws, { targetFiles: ['src/Services/EmailService.cs'] });
    expect(repEmail.directImpactedFiles).not.toContain('src/Web/OrderController.cs');

    // Verbatim `@"using MyApp.Fake;"` MUST produce zero edges!
    const repFake = await analyzer.analyzeImpact(ws, { targetFiles: ['src/Services/FakeService.cs'] });
    expect(repFake.directImpactedFiles.length).toBe(0);

    // Dynamic `Assembly.Load` surfaced in low-confidence warnings + Markdown report
    expect(repPay.lowConfidenceWarnings.some((w) => w.specifier === 'Assembly.Load')).toBe(true);
    const md = formatImpactReportMarkdown(repPay);
    expect(md).toContain('src/Web/OrderController.cs:2');
  });

  it('post-audit cross-validation: emoji UTF-16 offsets, Astro frontmatter strings, 2-hop chains, UTF-8 BOM, Allman C#, Rust #[path]/binary crate, Audit.java non-test, Kotlin non-filename symbols & cache invalidation', async () => {
    // 1. SFC emoji surrogate pairs inside HTML comment + Astro frontmatter containing `<script>` string + 2-hop chain
    const wsSfc = makeTempDir('da-audit-sfc-');
    writeFiles(wsSfc, {
      'src/core.ts': 'export const core = 1;\n',
      'src/fake.ts': 'export const fake = 0;\n',
      'src/Comp.vue': [
        '<template>',
        '  <!-- 🚀🔥 Launch button with surrogate-pair emojis! -->',
        '  <div>Hi</div>',
        '</template>',
        '<script setup lang="ts" generic="T extends Record<string, number>">',
        "import { core } from './core';",
        'console.log(core);',
        '</script>',
      ].join('\n'),
      'src/Page.svelte': [
        '<script lang="ts">',
        "import Comp from './Comp.vue';",
        'console.log(Comp);',
        '</script>',
      ].join('\n'),
      'src/Doc.astro': [
        '---',
        "import { core } from './core';",
        'const sample = \'<script>import { fake } from "./fake";</script>\';',
        'console.log(core, sample);',
        '---',
        '<main />',
      ].join('\n'),
    });
    const analyzer = new ImpactAnalyzer();
    const sfcRep = await analyzer.analyzeImpact(wsSfc, { targetFiles: ['src/core.ts'] });
    expect(sfcRep.directImpactedFiles).toContain('src/Comp.vue');
    expect(sfcRep.directImpactedFiles).toContain('src/Doc.astro');
    expect(sfcRep.indirectImpactedFiles).toContain('src/Page.svelte'); // 2-hop: core.ts -> Comp.vue -> Page.svelte
    const compEdge = sfcRep.edges.find((e) => e.from === 'src/Comp.vue' && e.to === 'src/core.ts');
    expect(compEdge?.line).toBe(6);
    const astroFakeRep = await analyzer.analyzeImpact(wsSfc, { targetFiles: ['src/fake.ts'] });
    expect(astroFakeRep.directImpactedFiles.length).toBe(0);

    // 2. Rust: single-line `#[path = "..."] mod`, binary-only crate `use crate::`, `{ use ...; }`, `extern crate`, single-quoted Cargo.toml
    const wsRust = makeTempDir('da-audit-rust-');
    writeFiles(wsRust, {
      'Cargo.toml': "[package]\nname = 'bin-only'\nversion = '0.1.0'\n",
      'src/main.rs': [
        '\uFEFF#[path = "custom_impl.rs"] mod custom;',
        'pub struct AppConfig;',
        'fn main() {}',
      ].join('\n'),
      'src/custom_impl.rs': [
        'pub fn run() { use crate::AppConfig; let _ = std::mem::size_of::<AppConfig>(); }',
      ].join('\n'),
    });
    const rustRepCustom = await analyzer.analyzeImpact(wsRust, { targetFiles: ['src/custom_impl.rs'] });
    expect(rustRepCustom.directImpactedFiles).toContain('src/main.rs');
    const rustRepMain = await analyzer.analyzeImpact(wsRust, { targetFiles: ['src/main.rs'] });
    expect(rustRepMain.directImpactedFiles).toContain('src/custom_impl.rs');

    // 3. Java & Kotlin: `Audit.java` MUST NOT be treated as a test file (`*IT.java` IS!), nested static import, Kotlin non-filename symbol, and package rename cache invalidation
    const wsJvm = makeTempDir('da-audit-jvm-');
    writeFiles(wsJvm, {
      'src/main/java/com/acme/sec/Audit.java': [
        '\uFEFFpackage com.acme.sec;',
        '@Service public class Audit {',
        '  public static class Builder { public static Audit create() { return new Audit(); } }',
        '}',
      ].join('\n'),
      'src/main/java/com/acme/sec/AuditConsumer.java': [
        'package com.acme.sec;',
        'public class AuditConsumer { Audit a; }',
      ].join('\n'),
      'src/main/java/com/acme/web/WebHandler.java': [
        'package com.acme.web;',
        'import static com.acme.sec.Audit.Builder.create;',
        'public class WebHandler { void go() { create(); } }',
      ].join('\n'),
      'src/test/java/com/acme/sec/AuditIT.java': [
        'package com.acme.sec;',
        'public class AuditIT { Audit a = new Audit(); }',
      ].join('\n'),
      'src/main/kotlin/com/acme/sec/AuthModels.kt': [
        'package com.acme.sec',
        'data class UserToken(val raw: String)',
        'fun verifyToken(t: UserToken): Boolean = t.raw.isNotEmpty()',
      ].join('\n'),
      'src/main/kotlin/com/acme/sec/AuthService.kt': [
        'package com.acme.sec',
        'class AuthService { fun check(t: UserToken) = verifyToken(t) }',
      ].join('\n'),
    });
    const jvmRepAudit = await analyzer.analyzeImpact(wsJvm, {
      targetFiles: ['src/main/java/com/acme/sec/Audit.java'],
    });
    const auditNode = jvmRepAudit.nodes.find((n) => n.id === 'src/main/java/com/acme/sec/Audit.java');
    expect(auditNode?.isTestFile).toBe(false);
    expect(jvmRepAudit.directImpactedFiles).toContain('src/main/java/com/acme/sec/AuditConsumer.java');
    expect(jvmRepAudit.directImpactedFiles).toContain('src/main/java/com/acme/web/WebHandler.java');
    expect(jvmRepAudit.recommendedTests.some((t) => t.testFile === 'src/test/java/com/acme/sec/AuditIT.java')).toBe(true);

    const jvmRepKt = await analyzer.analyzeImpact(wsJvm, {
      targetFiles: ['src/main/kotlin/com/acme/sec/AuthModels.kt'],
    });
    expect(jvmRepKt.directImpactedFiles).toContain('src/main/kotlin/com/acme/sec/AuthService.kt');

    // Renaming package in Audit.java MUST invalidate cached edges!
    fs.writeFileSync(
      path.join(wsJvm, 'src/main/java/com/acme/sec/Audit.java'),
      'package com.acme.moved;\npublic class Audit {}\n',
      'utf8',
    );
    const jvmRepMoved = await analyzer.analyzeImpact(wsJvm, {
      targetFiles: ['src/main/java/com/acme/sec/Audit.java'],
    });
    expect(jvmRepMoved.directImpactedFiles).not.toContain('src/main/java/com/acme/web/WebHandler.java');

    // 4. C#: UTF-8 BOM + Allman-style `namespace Foo\n{` + `[Attribute]` + namespace rename cache invalidation + Go inline quote comment & 2-hop
    const wsCs = makeTempDir('da-audit-cs-');
    writeFiles(wsCs, {
      'src/Billing/Invoice.cs': [
        '\uFEFFnamespace Acme.Billing',
        '{',
        '    [Serializable] public class Invoice',
        '    {',
        '        public decimal Total { get; set; }',
        '    }',
        '}',
      ].join('\n'),
      'src/Api/Checkout.cs': [
        '\uFEFFusing Acme.Billing;',
        'namespace Acme.Api',
        '{',
        '    [ApiController] public class Checkout { Invoice inv = new(); }',
        '}',
      ].join('\n'),
    });
    const csRep = await analyzer.analyzeImpact(wsCs, { targetFiles: ['src/Billing/Invoice.cs'] });
    expect(csRep.directImpactedFiles).toContain('src/Api/Checkout.cs');

    fs.writeFileSync(
      path.join(wsCs, 'src/Billing/Invoice.cs'),
      'namespace Acme.LegacyBilling\n{\n    public class Invoice {}\n}\n',
      'utf8',
    );
    const csRepMoved = await analyzer.analyzeImpact(wsCs, { targetFiles: ['src/Billing/Invoice.cs'] });
    expect(csRepMoved.directImpactedFiles).not.toContain('src/Api/Checkout.cs');

    // 5. Go: UTF-8 BOM + blank import `_` + inline comment with quotes + 2-hop transitive chain
    const wsGo = makeTempDir('da-audit-go-');
    writeFiles(wsGo, {
      'go.mod': 'module example.com/app\ngo 1.22\n',
      'pkg/db/db.go': '\uFEFFpackage db\nfunc Init() {}\n',
      'pkg/repo/repo.go': [
        '\uFEFFpackage repo',
        'import _ "example.com/app/pkg/db" // "driver init"',
        'func Load() {}',
      ].join('\n'),
      'cmd/srv/main.go': [
        'package main',
        'import "example.com/app/pkg/repo" // "entry"',
        'func main() { repo.Load() }',
      ].join('\n'),
    });
    const goRep = await analyzer.analyzeImpact(wsGo, { targetFiles: ['pkg/db/db.go'] });
    expect(goRep.directImpactedFiles).toContain('pkg/repo/repo.go');
    expect(goRep.indirectImpactedFiles).toContain('cmd/srv/main.go'); // 2-hop: db -> repo -> main
  });
});
