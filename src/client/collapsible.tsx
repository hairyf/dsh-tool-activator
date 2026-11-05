import type { ReactElement } from 'react'
import type { CollapsibleProps } from './types'
import { useId } from 'react'
import { CLASSES } from './constants'

/**
 * A section whose body folds away. The open state belongs to the caller: it is
 * a view preference for this visit, never part of the configuration draft, so
 * folding a card can neither dirty the page nor reach the Host.
 */
export function Collapsible({ actions, children, label, open, onToggle }: CollapsibleProps): ReactElement {
  // The body is referenced by the toggle so assistive technology can follow the
  // expand/collapse instead of guessing what the button controls.
  const bodyId = useId()
  return (
    <section className={CLASSES.collapsible}>
      <div className={CLASSES.collapsibleHeader}>
        <button
          aria-controls={bodyId}
          aria-expanded={open}
          className={CLASSES.collapsibleToggle}
          onClick={() => onToggle(!open)}
          type="button"
        >
          <span aria-hidden="true" className={CLASSES.collapsibleChevron} data-open={open ? 'true' : undefined}>▸</span>
          <span className={CLASSES.collapsibleLabel}>{label}</span>
        </button>
        {actions === undefined ? null : <div className={CLASSES.collapsibleActions}>{actions}</div>}
      </div>
      <div className={CLASSES.collapsibleBody} hidden={!open} id={bodyId}>
        {children}
      </div>
    </section>
  )
}
