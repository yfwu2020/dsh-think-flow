/** Integration checks: public test commands must rebuild real source and stop on compile errors. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'think-flow-build-'))
  for (const name of ['package.json', 'tsconfig.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'src', 'tests']) cpSync(join(ROOT, name), join(root, name), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  for (const name of ['build.sh', 'build.mjs', 'test.mjs', 'lint-templates.mjs']) {
    if (existsSync(join(ROOT, 'scripts', name))) cpSync(join(ROOT, 'scripts', name), join(root, 'scripts', name))
  }
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir')
  return root
}

function traceTest(root) {
  return spawnSync('npm', ['run', 'test:trace'], { cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, DSH_CHECKOUT: '' } })
}

test('test:trace replaces stale artifacts and builds the client on a fresh checkout', () => {
  const root = fixture()
  try {
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(root, 'lib/trace.js'), 'throw new Error("STALE_ARTIFACT")\n')
    const result = traceTest(root)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.ok(!readFileSync(join(root, 'lib/trace.js'), 'utf8').includes('STALE_ARTIFACT'))
    assert.ok(existsSync(join(root, 'lib/client.js')), 'client artifact must also be built')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('test:trace aborts before running tests when current host source does not typecheck', () => {
  const root = fixture()
  try {
    writeFileSync(join(root, 'src/trace.ts'), readFileSync(join(root, 'src/trace.ts'), 'utf8') + '\nconst buildTypeError: number = "invalid"\n')
    const result = traceTest(root)
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, /TS2322/)
    assert.ok(!result.stdout.includes('① 基本聚合'), 'tests must not run after a build error')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('packing a clean checkout builds all entries and excludes private/development files', () => {
  const root = fixture()
  try {
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs/private-session.json'), '{"private":true}')
    const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', timeout: 60_000 })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const packed = JSON.parse(result.stdout)
    const paths = new Set(packed[0].files.map((file) => file.path))
    for (const entry of ['lib/index.js', 'lib/client.js', 'lib/types/index.d.ts', 'lib/host/routes.js', 'src/client/styles.css', 'cordis.patch.yml']) {
      assert.ok(paths.has(entry), 'missing package entry: ' + entry)
    }
    assert.ok(![...paths].some((name) => /^(docs|scripts|tests|node_modules)\//.test(name)), 'development or private files must not ship')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
