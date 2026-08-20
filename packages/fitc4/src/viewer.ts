/**
 * Deep links into a published LikeC4 viewer.
 *
 * `likec4 build` serves each view at `/view/<viewId>/`, or at `#/view/<viewId>/`
 * when built with `--use-hash-history` (verified against the installed likec4
 * app bundle, which registers the TanStack route `/view/$viewId` with
 * `trailingSlash: "always"` and switches to `createHashHistory` under that
 * flag). When a config sets `viewerBaseUrl`, every finding gets a link to the
 * most specific view showing the elements it references, so a finding pasted
 * into an issue lands on the diagram.
 *
 * Everything here is derived from the loaded model and the configured base
 * URL: deterministic, offline, and recomputed per run.
 */

import type { LikeC4Model } from './model.ts'
import type { Finding } from './types.ts'

/** The view every model renders first, and the fallback link target. */
export const INDEX_VIEW_ID = 'index'

/**
 * The URL of one view.
 *
 * A base ending in `#` or `#/` means the viewer was built with
 * `--use-hash-history`, so the view path goes into the fragment. Trailing
 * slashes on the base are normalized away so no link carries a double slash.
 */
export function viewerLink(baseUrl: string, viewId: string): string {
  const view = `view/${encodeURIComponent(viewId)}/`
  const trimmed = baseUrl.trim()

  if (trimmed.endsWith('#') || trimmed.endsWith('#/')) {
    const origin = trimmed.replace(/#\/?$/, '').replace(/\/+$/, '')
    return `${origin}/#/${view}`
  }
  return `${trimmed.replace(/\/+$/, '')}/${view}`
}

/**
 * The view a finding should link to.
 *
 * Best effort by design: among the views containing every element the finding
 * references, the one with the fewest nodes wins, ties broken by view id, so
 * the link lands on the tightest diagram that still shows the whole story. A
 * finding with no element refs, or elements no view shows together, falls back
 * to the index view. `undefined` only when the model has no index view either.
 */
export function viewIdFor(model: LikeC4Model, finding: Finding): string | undefined {
  const elements = elementRefs(finding)

  let best: { id: string; size: number } | undefined
  if (elements.length > 0) {
    for (const view of model.views()) {
      if (!elements.every((id) => view.includesElement(id))) continue
      const size = [...view.nodes()].length
      if (best === undefined || size < best.size || (size === best.size && view.id < best.id)) {
        best = { id: view.id, size }
      }
    }
  }

  return best?.id ?? model.findView(INDEX_VIEW_ID)?.id
}

/**
 * Attach a viewer link to each finding that can get one.
 *
 * A link a provider already set is kept; nothing standard emits one, but the
 * pipeline must not overwrite what a provider deliberately said.
 */
export function withViewerLinks(
  findings: Finding[],
  model: LikeC4Model,
  baseUrl: string,
): Finding[] {
  return findings.map((finding) => {
    if (finding.link !== undefined) return finding
    const viewId = viewIdFor(model, finding)
    if (viewId === undefined) return finding
    return { ...finding, link: viewerLink(baseUrl, viewId) }
  })
}

/** The model element ids a finding references, deduplicated. */
function elementRefs(finding: Finding): string[] {
  const ids = [finding.subject, ...(finding.related ?? [])]
    .filter((ref) => ref !== undefined && ref.kind === 'element')
    .map((ref) => (ref as { id: string }).id)
  return [...new Set(ids)]
}
