import { CLASSES, STYLE_TAG_ID } from './constants'

/**
 * One stylesheet shipped as an owned `<style data-plugin-css>` tag, the
 * convention the client module system records (`ClientModuleRecord.styles`) and
 * drops with the bundle. No CSS-in-JS runtime is bundled: the plugin stays
 * independent of any host application's styling stack. Colours come from the
 * platform's design tokens, with plain fallbacks for a host that lacks them.
 */
const CSS = `
.${CLASSES.root}{display:grid;gap:12px;color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:20px}
.${CLASSES.header}{display:grid;gap:2px}
.${CLASSES.title}{margin:0;font-size:14px;font-weight:600;line-height:22px}
.${CLASSES.description}{margin:0;color:var(--dsw-alias-label-secondary,inherit)}
.${CLASSES.help}{margin:0;color:var(--dsw-alias-label-caption,inherit);font-size:12px;line-height:18px}
.${CLASSES.error}{margin:0;color:var(--dsw-alias-state-error-primary,#d63e3e)}
.${CLASSES.success}{margin:0;color:var(--dsw-alias-state-success-primary,inherit)}
.${CLASSES.section}{display:grid;gap:8px}
.${CLASSES.sectionTitle}{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,inherit)}
.${CLASSES.list}{display:grid;gap:0;margin:0;padding:0;list-style:none;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.25));border-radius:16px;overflow:hidden}
.${CLASSES.row}{display:flex;align-items:center;gap:12px;padding:10px 12px;border-top:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.25))}
.${CLASSES.row}:first-child{border-top:0}
.${CLASSES.rowText}{display:grid;gap:2px;min-width:0;flex:1 1 auto}
.${CLASSES.rowName}{font-weight:500;overflow-wrap:anywhere}
.${CLASSES.rowMeta}{color:var(--dsw-alias-label-caption,inherit);font-size:12px;line-height:18px;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-clamp:3;overflow:hidden}
.${CLASSES.rowState}{flex:0 0 auto;color:var(--dsw-alias-label-caption,inherit);font-size:12px;white-space:nowrap}
.dsh-tool-activator-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:10px;background:var(--dsw-alias-border-l3,rgba(127,127,127,.4));cursor:pointer}
.dsh-tool-activator-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary,#4d6bfe)}
.dsh-tool-activator-switch:disabled{cursor:default;opacity:.5}
.dsh-tool-activator-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}
.dsh-tool-activator-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground,#fff);transition:transform .12s ease}
.dsh-tool-activator-switch[aria-checked=true] .dsh-tool-activator-switch-thumb{transform:translate(16px)}
`

export function ownedStyleTag(): HTMLStyleElement | null {
  return document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${STYLE_TAG_ID}"]`)
}

export function mountToolActivatorStyles(): () => void {
  if (typeof document === 'undefined')
    return () => {}
  if (ownedStyleTag() !== null)
    return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-tool-activator'
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = CSS
  document.head.append(tag)
  return () => tag.remove()
}
