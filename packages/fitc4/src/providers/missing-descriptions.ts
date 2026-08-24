/**
 * The `missing-descriptions` validate provider.
 *
 * One info finding per model element whose description is absent, empty, or
 * still the TODO placeholder that `init` and `draft` scaffold. Opt-in, never
 * part of the standard composition: a description is documentation, not structure,
 * and the standard gate judges structure only. What this rule buys a team
 * that wants it is countability. Every undescribed element is one visible
 * finding, so the report's info line becomes the documentation burn-down the
 * same way the drift line counts declared debt.
 *
 * Deterministic on purpose, and deliberately separate from the agent tier:
 * `draft --describe` proposes descriptions at draft time and
 * `agentSemanticReview` critiques existing ones, but only this rule says
 * which elements have none at all, with no model call and no exec configured.
 */

import { findingId } from '../ids.ts'
import { isPlaceholderDescription } from '../model.ts'
import type { Finding, NamedProvider, ValidateContext, ValidateProvider } from '../types.ts'

export const PROVIDER_ID = 'missing-descriptions'

const RULE_ID = 'missing-description'

/**
 * Returns a `NamedProvider`, ready to append to a config's `validate` array:
 * `validate: [architectureRules(), missingDescriptions()]`.
 */
export function missingDescriptions(): NamedProvider<ValidateProvider> {
  const run: ValidateProvider = async (context: ValidateContext): Promise<Finding[]> => {
    const findings: Finding[] = []

    for (const element of context.model.elements()) {
      const reason = undescribedReason(descriptionText(element.description))
      if (reason === undefined) continue
      findings.push({
        id: findingId(PROVIDER_ID, RULE_ID, element.id),
        ruleId: RULE_ID,
        severity: 'info',
        description: `${element.id} ${reason}.`,
        subject: { kind: 'element', id: element.id },
        provider: PROVIDER_ID,
      })
    }

    return findings.sort((a, b) => a.id.localeCompare(b.id))
  }

  return { id: PROVIDER_ID, run }
}

/**
 * Why an element counts as undescribed, or undefined when it is described.
 *
 * The placeholder test itself comes from `isPlaceholderDescription` in the
 * core model vocabulary, so this rule and the agent tier's semantic review
 * cannot disagree about what a scaffolded `TODO` is. Only the wording of each
 * reason belongs to this rule.
 */
function undescribedReason(description: string | undefined): string | undefined {
  if (description === undefined) return 'has no description'
  if (description.trim() === '') return 'has an empty description'
  if (isPlaceholderDescription(description)) return 'still carries a TODO description'
  return undefined
}

/**
 * A plain-text description off a LikeC4 element. LikeC4 stores descriptions
 * as a string or a `{ txt | md }` wrapper depending on authoring form.
 * Duplicated from the agent tier's `elementText` on purpose: this provider is
 * core, and core never imports from `@arocnies/fitc4/agent`.
 */
function descriptionText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    const wrapper = value as { txt?: unknown; md?: unknown }
    if (typeof wrapper.txt === 'string') return wrapper.txt
    if (typeof wrapper.md === 'string') return wrapper.md
  }
  return undefined
}
