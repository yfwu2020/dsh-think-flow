/** Every public test entry point builds current source once before executing artifact tests. */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const suites = ['trace', 'titles', 'routes', 'translate', 'client', 'shutdown']
const selected = process.argv.slice(2)
if (selected.some((name) => !suites.includes(name))) {
  console.error('Unknown test suite. Choose: ' + suites.join(', '))
  process.exit(1)
}
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run(['scripts/build.mjs'])
if (selected.length === 0) run(['scripts/lint-templates.mjs'])
for (const name of selected.length ? selected : suites) run(['tests/test-' + name + '.mjs'])
if (selected.length === 0) run(['--test', 'tests/test-build.mjs'])
