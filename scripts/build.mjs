#!/usr/bin/env node
/**
 * Build the two published entry points.
 *
 * Host (`lib/index.js`): a plain ESM module. Everything the harness provides is
 * external — this plugin must run against the host's own copies, never bundled
 * duplicates of `@deepseek-ai/*`.
 *
 * Client (`lib/client.js`): a CommonJS factory wrapped in the harness's browser
 * module-loader call, matching what the shipped client packages emit. `react`
 * and the `@deepseek-ai/*` client packages come from the loader's `require`;
 * everything else — the depiction and layout libraries — is bundled in, because
 * a client bundle is served as one self-contained file.
 */

import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Anything under the harness's own scope is supplied by the host. */
const harnessScope = { name: 'harness-external', setup(build) {
  build.onResolve({ filter: /^@deepseek-ai\// }, (args) => ({ path: args.path, external: true }))
} }

const shared = {
  bundle: true,
  minify: false,
  sourcemap: true,
  logLevel: 'info',
  // Source files import each other with explicit `.ts` / `.tsx` extensions.
  resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],
}

async function buildHost() {
  await build({
    ...shared,
    entryPoints: [join(root, 'src/index.ts')],
    outfile: join(root, 'lib/index.js'),
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    plugins: [harnessScope],
  })
}

async function buildClient() {
  await build({
    ...shared,
    entryPoints: [join(root, 'src/client/index.ts')],
    outfile: join(root, 'lib/client.js'),
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    // Provided by the browser module loader; bundling our own React would give
    // the page two Reacts and break hooks.
    external: ['react', 'react/jsx-runtime', 'react-dom'],
    plugins: [harnessScope],
    banner: {
      js: `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(pkg.name)},\n\tfactory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;`,
    },
    footer: { js: 'return module.exports;\n\t}\n});' },
  })
}

rmSync(join(root, 'lib'), { recursive: true, force: true })
await buildHost()
await buildClient()
