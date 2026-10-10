import { readFile } from 'node:fs/promises'
import { CssRender } from 'css-render'
import { describe, expect, it } from 'vitest'
import * as client from '../src/client/index'
import * as host from '../src/index'

const root = new URL('../', import.meta.url)

describe('source distribution contracts', () => {
  it('exports the host configuration and lifecycle without generated artifacts', () => {
    expect(Object.keys(host).sort()).toEqual(['Config', 'apply', 'inject', 'name'])
    expect(host.inject).toEqual(['tools', 'systemPrompt', 'agents', 'sessionProjections'])
    expect(host.name).toBe('tool-activator')
    expect(host.Config({}).get().basicTools).toEqual(['read', 'glob', 'grep', 'skill', 'ask_user_question', 'todo_write'])
  })

  it('exports only the official client lifecycle and service dependency', () => {
    expect(Object.keys(client).sort()).toEqual(['apply', 'inject'])
    expect(client.inject).toEqual(['slots'])
  })

  it('declares the requested repository, minimum core, icon, and client owners', async () => {
    const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
    expect(manifest.name).toBe('dsh-tool-activator')
    expect(manifest.repository.url).toBe('git+https://github.com/hairyf/dsh-tool-activator.git')
    expect(manifest.peerDependencies['@deepseek-ai/dsh']).toBe('>=0.2.0-rc.2')
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.exports['./icon']).toBe('./icon.svg')
    expect(manifest.dsh.client.inject).toEqual(['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-plugin-manager'])
    expect(manifest.scripts.test).toBe('vitest run')
    expect(manifest.files).not.toContain('source')
  })

  it('takes the css-render factory from its named export', async () => {
    // The client bundle is CJS: node-mode interop overwrites a CJS dependency's
    // `default` with the module object, so a default import is not callable at
    // runtime even though it type-checks.
    const styles = await readFile(new URL('src/client/styles.ts', root), 'utf8')
    expect(styles).toContain('import { CssRender } from \'css-render\'')
    expect(styles).not.toContain('import CssRender from \'css-render\'')
    expect(typeof CssRender).toBe('function')
  })

  it('shares the official row identity and a local safe SVG', async () => {
    const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')
    expect(patch).toMatch(/^- insert:\r?\n {4}- id: tool-activator\r?\n {6}name: dsh-tool-activator\r?\n$/u)
    const icon = await readFile(new URL('icon.svg', root), 'utf8')
    expect(icon).toMatch(/^<svg /u)
    expect(icon).toContain('<path ')
    expect(icon.replace('xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(/<script|https?:|onload=|href=/iu)
  })
})
