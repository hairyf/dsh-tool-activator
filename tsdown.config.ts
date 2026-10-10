import type { UserConfig } from 'tsdown'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { defineConfig } from 'tsdown'

export const dshExternal = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  /^@deepseek-ai\//,
]

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { name: string }
const id = JSON.stringify(pkg.name)

const common: UserConfig = {
  outDir: 'dist',
  format: 'esm',
  outExtensions: () => ({ js: '.js' }),
  publint: true,
  external: dshExternal,
}

export default defineConfig([
  {
    ...common,
    entry: { index: 'src/index.ts' },
    dts: true,
    sourcemap: false,
    clean: true,
  },
  {
    ...common,
    entry: { client: 'src/client/index.ts' },
    format: 'cjs',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    banner: `window.__ModuleLoader__.load({id:${id},factory:(require)=>{var module={exports:{}};var exports=module.exports;`,
    footer: 'return module.exports;}});',
    dts: false,
    sourcemap: true,
    minify: true,
    clean: false,
  },
])
