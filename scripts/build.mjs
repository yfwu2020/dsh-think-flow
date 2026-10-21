/** Build host ESM/declarations and the browser ModuleLoader bundle with project-local tools. */
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const localRequire = createRequire(join(ROOT, 'package.json'))
const tsc = localRequire.resolve('typescript/bin/tsc')

rmSync(join(ROOT, 'lib'), { recursive: true, force: true })
const result = spawnSync(process.execPath, [tsc, '-p', join(ROOT, 'tsconfig.json')], { cwd: ROOT, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

await build({
  absWorkingDir: ROOT,
  entryPoints: ['src/client/index.js'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  charset: 'utf8',
  sourcemap: true,
  keepNames: true,
  logLevel: 'info',
  loader: { '.css': 'text' },
})
console.error('Build complete: lib/ (host, client, declarations, source maps)')
