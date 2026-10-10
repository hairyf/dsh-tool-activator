// The client bundle is emitted as CJS, and node-mode interop replaces a CJS
// dependency's `default` with the module object, so the default import would
// resolve to a non-callable value at runtime. The named export survives.
import { CssRender } from 'css-render'
import { CLASSES, STYLE_ID } from './constants'

export function mountToolActivatorStyles(): () => void {
  if (typeof document === 'undefined')
    return () => {}
  const cssr = CssRender()
  if (cssr.find(STYLE_ID) !== null)
    return () => {}
  const root = `.${CLASSES.root}`
  const style = cssr.c([
    cssr.c(root, {
      color: 'inherit',
      maxWidth: '54rem',
      width: '100%',
      padding: '1rem',
      lineHeight: '1.6',
    }, [
      cssr.c('*, *::before, *::after', { boxSizing: 'border-box' }),
      cssr.c('p', { margin: '0.5rem 0' }),
      cssr.c('label, legend, summary', { fontWeight: '600' }),
      cssr.c('legend', { padding: '0 0.35rem' }),
      cssr.c('textarea, select', {
        width: '100%',
        padding: '0.6rem 0.75rem',
        border: '1px solid color-mix(in srgb, currentColor 30%, transparent)',
        borderRadius: '0.5rem',
        color: 'inherit',
        background: 'inherit',
        font: 'inherit',
      }),
      cssr.c('textarea', { resize: 'vertical', fontFamily: 'ui-monospace, monospace' }),
      cssr.c('input[type="checkbox"]', { accentColor: 'currentColor', width: '1rem', height: '1rem' }),
      cssr.c('button', {
        border: '1px solid color-mix(in srgb, currentColor 35%, transparent)',
        borderRadius: '0.5rem',
        padding: '0.55rem 0.9rem',
        color: 'inherit',
        background: 'color-mix(in srgb, currentColor 6%, transparent)',
        font: 'inherit',
        cursor: 'pointer',
      }),
      cssr.c('button:hover:not(:disabled)', { background: 'color-mix(in srgb, currentColor 12%, transparent)' }),
      cssr.c(':disabled', { opacity: '0.6', cursor: 'not-allowed' }),
      cssr.c('fieldset:disabled', { opacity: '1' }),
      cssr.c('input:focus-visible, textarea:focus-visible, select:focus-visible, button:focus-visible, summary:focus-visible', {
        outline: '2px solid currentColor',
        outlineOffset: '3px',
      }),
    ]),
    cssr.c(`${root} .${CLASSES.header}`, { display: 'flex', alignItems: 'flex-start', gap: '0.75rem', marginBottom: '1rem' }),
    cssr.c(`${root} .${CLASSES.icon}`, { width: '1.5rem', height: '1.5rem', flexShrink: '0', marginTop: '0.3rem' }),
    cssr.c(`${root} .${CLASSES.title}`, { margin: '0', fontSize: '1.25rem', lineHeight: '1.4' }),
    cssr.c(`${root} .${CLASSES.description}`, { opacity: '0.8' }),
    cssr.c(`${root} .${CLASSES.notice}`, {
      borderLeft: '3px solid color-mix(in srgb, currentColor 55%, transparent)',
      borderRadius: '0.25rem',
      background: 'color-mix(in srgb, currentColor 5%, transparent)',
      padding: '0.65rem 0.8rem',
    }),
    cssr.c(`${root} .${CLASSES.version}, ${root} .${CLASSES.help}`, { fontSize: '0.875rem', opacity: '0.8' }),
    cssr.c(`${root} .${CLASSES.fields}`, { display: 'grid', gap: '0.8rem', border: '0', padding: '0', margin: '1rem 0', minWidth: '0' }),
    cssr.c(`${root} .${CLASSES.field}`, { display: 'grid', gap: '0.35rem', minWidth: '0' }),
    cssr.c(`${root} .${CLASSES.checkbox}`, { display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer' }),
    cssr.c(`${root} .${CLASSES.advanced}`, { borderTop: '1px solid color-mix(in srgb, currentColor 20%, transparent)', paddingTop: '0.8rem' }, [
      cssr.c('summary', { cursor: 'pointer', marginBottom: '0.8rem' }),
      cssr.c(`.${CLASSES.field}`, { marginBottom: '1rem' }),
    ]),
    cssr.c(`${root} .${CLASSES.actions}`, { display: 'flex', flexWrap: 'wrap', gap: '0.65rem', marginTop: '1rem' }),
    cssr.c(`${root} .${CLASSES.error}`, { color: 'var(--color-danger, #d63e3e)', fontWeight: '600' }),
    cssr.c(`${root} .${CLASSES.success}`, { color: 'inherit', fontWeight: '600' }),
  ])
  style.mount({ id: STYLE_ID, head: true })
  const ownedStyle = cssr.find(STYLE_ID)
  return () => {
    if (ownedStyle !== null && cssr.find(STYLE_ID) === ownedStyle)
      style.unmount({ id: STYLE_ID })
  }
}
