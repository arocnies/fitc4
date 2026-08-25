/**
 * `agentResolve` tests inject a stub `AgentExec` and run the real pipeline over the
 * `external` fixture — a repository depending on external packages, checked
 * against a model with description-only elements. Under test: leftover-
 * candidate scoping, the collapse of import sites into per-(owner, package)
 * decisions and the fan-out back to per-site associations, context assembly,
 * the fail-closed contract (exec failure, off-schema reply, hallucinated
 * candidateId, unknown elementId), the legitimate-abstention paths (empty
 * reply, truncation), cache composition — and the point of the feature: an
 * agent-mapped association is judged by the standard relationship rules
 * exactly like a deterministic one.
 *
 * No real agent CLI is ever invoked: the exec is an in-process stub.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

import { cached } from '../src/agent/cache.ts'
import type { AgentExec, AgentReply, AgentRequest } from '../src/agent/exec.ts'
import { agentResolve, PROVIDER_ID as RESOLVE_ID } from '../src/agent/resolve.ts'
import { sourceRoot } from '../src/providers/source-root.ts'
import type { Finding } from '../src/types.ts'
import { findingFor, runFixture, SOURCE_ROOT_ID } from './helpers.ts'

function stubExec(replies: AgentReply[]): AgentExec & { requests: AgentRequest[] } {
  const exec = {
    id: 'stub/model',
    requests: [] as AgentRequest[],
    async run(request: AgentRequest): Promise<AgentReply> {
      exec.requests.push(request)
      const reply = replies[Math.min(exec.requests.length, replies.length) - 1]
      if (reply === undefined) throw new Error('stub exhausted')
      return reply
    },
  }
  return exec
}

function ok(value: unknown): AgentReply {
  return { ok: true, value: value as never, raw: JSON.stringify(value) }
}

// The exact namespaced observation ids the `external` fixture's scan produces.
const STRIPE_ID = 'typescript-imports/dependency:src/index.ts:1->stripe'
const STRIPE_SUBPATH_ID = 'typescript-imports/dependency:src/more.ts:4->stripe/webhooks'
const AMQP_ID = 'typescript-imports/dependency:src/index.ts:2->amqplib'
const MISSING_ID = 'typescript-imports/dependency:src/index.ts:3->./missing.js'

// The candidate decisions those observations collapse into: one per distinct
// (owning element, package-or-specifier), stable across import-site churn.
const STRIPE_DECISION = 'demo.app.core=>stripe'
const AMQP_DECISION = 'demo.app.core=>amqplib'
const MISSING_DECISION = 'demo.app.core=>./missing.js'

/** Alongside the default resolver, exactly as the docs compose it. */
function resolvePhase(exec: AgentExec, options: { maxObservations?: number } = {}) {
  return [sourceRoot(), agentResolve({ exec, ...options })]
}

function providerFailure(findings: Finding[]): Finding | undefined {
  return findingFor(findings, 'provider-failure')
}

describe('agentResolve end to end', () => {
  test('an agent-mapped external dependency is judged by the standard relationship rules', async () => {
    const exec = stubExec([
      ok([
        // Undeclared in the model → must surface as missing-relationship.
        { candidateId: STRIPE_DECISION, elementId: 'demo.external.payments', reason: 'stripe is the payments gateway' },
        // Declared (demo.app.core -> demo.external.queue) → must pass silently.
        { candidateId: AMQP_DECISION, elementId: 'demo.external.queue' },
      ]),
    ])

    const result = await runFixture('external', { resolve: resolvePhase(exec) })

    // The description-only element became reachable by the gate: the standard
    // rules judged the agent-mapped edge and found it undeclared.
    const missing = result.findings.filter((finding) => finding.ruleId === 'missing-relationship')
    expect(missing).toHaveLength(1)
    expect(missing[0]?.severity).toBe('error')
    expect(missing[0]?.subject).toEqual({ kind: 'element', id: 'demo.app.core' })
    expect(missing[0]?.related).toEqual([{ kind: 'element', id: 'demo.external.payments' }])

    // The declared edge passes: mapped, matched to the declared relationship,
    // and no finding — same treatment a deterministic association gets.
    const queueMapping = result.associations.find(
      (association) => association.observationId === AMQP_ID && association.provider === 'agent-resolve',
    )
    expect(queueMapping?.status).toBe('resolved')
    expect(queueMapping?.target).toEqual({ kind: 'element', id: 'demo.external.queue' })
    expect(queueMapping?.relationship).toBeDefined()

    // The mapping's provenance, decision, and reason ride in data.
    const paymentsMapping = result.associations.find(
      (association) => association.observationId === STRIPE_ID && association.provider === 'agent-resolve',
    )
    expect(paymentsMapping?.data).toEqual({
      agent: 'stub/model',
      candidateId: STRIPE_DECISION,
      reason: 'stripe is the payments gateway',
    })

    expect(providerFailure(result.findings)).toBeUndefined()
    expect(findingFor(result.findings, 'orphaned-association')).toBeUndefined()
  })

  test('same-package import sites collapse to one decision and fan back out on acceptance', async () => {
    const exec = stubExec([
      ok([{ candidateId: STRIPE_DECISION, elementId: 'demo.external.payments' }]),
    ])

    const result = await runFixture('external', { resolve: resolvePhase(exec) })

    // Two stripe import sites (`stripe`, `stripe/webhooks`) were ONE candidate
    // with the site count announced — one question, asked once.
    const context = exec.requests[0]?.context ?? ''
    expect(context.split(STRIPE_DECISION)).toHaveLength(2)
    expect(context).toContain('at 2 import sites: src/index.ts:1, src/more.ts:4')
    expect(context).not.toContain('observationId')

    // The accepted decision fanned back out: one association per site, so the
    // standard rules still see every import.
    const mapped = result.associations.filter(
      (association) =>
        association.provider === 'agent-resolve' &&
        association.target?.id === 'demo.external.payments',
    )
    expect(mapped.map((association) => association.observationId).sort()).toEqual([
      STRIPE_ID,
      STRIPE_SUBPATH_ID,
    ])
    expect(providerFailure(result.findings)).toBeUndefined()
  })

  test('the context carries the element catalog and only the leftover decisions', async () => {
    const exec = stubExec([ok([])])
    const messages: string[] = []

    await runFixture('external', {
      resolve: resolvePhase(exec),
      onProgress: (message) => void messages.push(message),
    })

    // The call is announced before it starts: it is the slow part of the
    // phase, and the candidate count says what is being paid for.
    expect(messages).toContainEqual('agent-resolve: asking stub/model to map 3 candidates')

    const request = exec.requests[0]
    expect(exec.requests).toHaveLength(1)
    expect(request?.schema).toBeDefined()
    expect(request?.agentic).toBeUndefined()
    // The catalog names the description-only elements the mapping targets.
    expect(request?.context).toContain('Elements in the architecture model')
    expect(request?.context).toContain('demo.external.payments')
    expect(request?.context).toContain('Third-party payments API')
    // Decisions: both external-module packages and the unresolvable specifier.
    expect(request?.context).toContain(`candidateId: ${STRIPE_DECISION}`)
    expect(request?.context).toContain(`candidateId: ${AMQP_DECISION}`)
    expect(request?.context).toContain(`candidateId: ${MISSING_DECISION}`)
    expect(request?.context).toContain('references unresolvable module ./missing.js')
    // NOT the internal file dependency — that is source-root's job.
    expect(request?.context).not.toContain('->./util.js')
    expect(request?.context).not.toContain('=>./util.js')
    expect(request?.context).not.toContain('truncated')
    // Measured on a real repository: without this steer the model mapped
    // psycopg, sqlalchemy, alembic, and prometheus_client onto the draft's
    // catch-all package element instead of the PostgreSQL and Prometheus
    // elements whose descriptions name them, which is the whole use case.
    expect(request?.prompt).toContain('client, driver, SDK, or protocol library')
    expect(request?.prompt).toContain('rather than onto a general library or external-package bucket')
  })

  test('a claimed package is never a candidate — source-root already maps it deterministically', async () => {
    const exec = stubExec([ok([])])

    // The `packages` fixture claims pg, @aws-sdk/client-s3, and oldpkg via
    // `packages` metadata; lodash is unclaimed.
    const result = await runFixture('packages', { resolve: resolvePhase(exec) })

    const context = exec.requests[0]?.context ?? ''
    expect(exec.requests).toHaveLength(1)
    // The unclaimed package is offered to the agent, as a decision.
    expect(context).toContain('=>lodash')
    // Claimed packages are not — including subpath imports of a claim.
    expect(context).not.toContain('pg/promises')
    expect(context).not.toContain('@aws-sdk/client-s3')
    expect(context).not.toContain('oldpkg')

    expect(providerFailure(result.findings)).toBeUndefined()
  })

  test('a repository with no leftover candidates costs zero agent calls', async () => {
    const exec = stubExec([])

    const result = await runFixture('ok', { resolve: resolvePhase(exec) })

    expect(exec.requests).toHaveLength(0)
    expect(providerFailure(result.findings)).toBeUndefined()
  })
})

describe('agentResolve abstention is legitimate', () => {
  test('an empty mapping reply is a clean no-op — candidates stay unmapped, not failed', async () => {
    const exec = stubExec([ok([])])

    const result = await runFixture('external', { resolve: resolvePhase(exec) })

    expect(providerFailure(result.findings)).toBeUndefined()
    expect(result.associations.filter((a) => a.provider === 'agent-resolve')).toEqual([])
    // Unmapped candidates keep their deterministic visibility: no
    // missing-relationship (nothing was mapped), and the unresolvable import
    // still stands as its usual warning.
    expect(findingFor(result.findings, 'missing-relationship')).toBeUndefined()
    expect(findingFor(result.findings, 'unresolved-import')?.severity).toBe('warning')
  })

  test('truncation counts decisions, is announced in the context, and is non-fatal', async () => {
    const exec = stubExec([
      ok([{ candidateId: MISSING_DECISION, elementId: 'demo.external.payments' }]),
    ])

    const result = await runFixture('external', {
      resolve: resolvePhase(exec, { maxObservations: 1 }),
    })

    const context = exec.requests[0]?.context ?? ''
    // Decisions sort by candidateId, so the unresolvable specifier is the one
    // sent; the stripe decision (two sites) and amqplib stay behind the limit.
    expect(context).toContain(MISSING_DECISION)
    expect(context).not.toContain(STRIPE_DECISION)
    expect(context).not.toContain(AMQP_DECISION)
    expect(context).toContain('truncated')
    expect(context).toContain('2 more candidate decisions')

    // The truncated decisions are simply unmapped; the sent one still lands.
    expect(providerFailure(result.findings)).toBeUndefined()
    const mapped = result.associations.find(
      (association) => association.provider === 'agent-resolve',
    )
    expect(mapped?.observationId).toBe(MISSING_ID)
    expect(mapped?.target).toEqual({ kind: 'element', id: 'demo.external.payments' })
  })
})

describe('agentResolve fails closed', () => {
  test('an exec failure fails the provider — one provider-failure error, not fewer checks', async () => {
    const exec = stubExec([{ ok: false, error: 'not logged in' }])

    const result = await runFixture('external', { resolve: resolvePhase(exec) })

    const failure = providerFailure(result.findings)
    expect(failure?.severity).toBe('error')
    expect(failure?.subject).toEqual({ kind: 'provider', id: 'agent-resolve' })
    expect(failure?.description).toContain('not logged in')
    expect(result.associations.filter((a) => a.provider === 'agent-resolve')).toEqual([])
  })

  test('an off-schema reply fails the provider', async () => {
    const exec = stubExec([ok({ mappings: 'sure' })])

    const result = await runFixture('external', { resolve: resolvePhase(exec) })

    const failure = providerFailure(result.findings)
    expect(failure?.severity).toBe('error')
    expect(failure?.description).toContain('did not match the requested schema')
  })

  test('a reply keyed on the old observationId shape fails the provider', async () => {
    const exec = stubExec([
      ok([{ observationId: STRIPE_ID, elementId: 'demo.external.payments' }]),
    ])

    const result = await runFixture('external', { resolve: resolvePhase(exec) })

    // A stale cache entry or custom adapter speaking the pre-decision shape
    // must fail visibly, never flow half-parsed into the pipeline.
    expect(providerFailure(result.findings)?.severity).toBe('error')
  })

  test('a hallucinated candidateId fails the provider, never a silent drop', async () => {
    const exec = stubExec([
      ok([{ candidateId: 'demo.app.core=>invented-pkg', elementId: 'demo.external.payments' }]),
    ])

    const result = await runFixture('external', { resolve: resolvePhase(exec) })

    const failure = providerFailure(result.findings)
    expect(failure?.severity).toBe('error')
    expect(failure?.description).toContain('candidateId it was not given')
    // Nothing from the untrustworthy reply landed — no half-result.
    expect(result.associations.filter((a) => a.provider === 'agent-resolve')).toEqual([])
  })

  test('an element that is not in the model fails the provider', async () => {
    const exec = stubExec([
      ok([{ candidateId: STRIPE_DECISION, elementId: 'demo.external.nope' }]),
    ])

    const result = await runFixture('external', { resolve: resolvePhase(exec) })

    const failure = providerFailure(result.findings)
    expect(failure?.severity).toBe('error')
    expect(failure?.description).toContain('not in the model')
  })

  test('mapping one decision twice fails the provider — contradictions are not resolved by order', async () => {
    const exec = stubExec([
      ok([
        { candidateId: STRIPE_DECISION, elementId: 'demo.external.payments' },
        { candidateId: STRIPE_DECISION, elementId: 'demo.external.queue' },
      ]),
    ])

    const result = await runFixture('external', { resolve: resolvePhase(exec) })

    expect(providerFailure(result.findings)?.description).toContain('more than once')
  })
})

describe('agentResolve composition', () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-agent-resolve-cache-'))
  afterAll(() => fs.rmSync(cacheDir, { recursive: true, force: true }))

  test('works under cached(): the second run replays the reply without a call', async () => {
    const exec = stubExec([
      ok([{ candidateId: STRIPE_DECISION, elementId: 'demo.external.payments' }]),
    ])
    const phase = resolvePhase(cached(exec, { directory: cacheDir }))

    const first = await runFixture('external', { resolve: phase })
    const second = await runFixture('external', { resolve: phase })

    expect(exec.requests).toHaveLength(1)
    expect(providerFailure(second.findings)).toBeUndefined()
    expect(second.associations).toEqual(first.associations)
    expect(findingFor(second.findings, 'missing-relationship')).toBeDefined()
  })

  test('the id option suffixes the provider id so two instances coexist', async () => {
    const exec = stubExec([ok([])])

    const result = await runFixture('external', {
      resolve: [
        sourceRoot(),
        agentResolve({ exec, id: 'infra' }),
        agentResolve({ exec, id: 'apis' }),
      ],
    })

    expect(result.providers.resolve).toEqual(['source-root', 'agent-resolve:infra', 'agent-resolve:apis'])
    expect(providerFailure(result.findings)).toBeUndefined()
  })
})

// The provider id doubles as the association-id and finding-id namespace; a
// rename would churn every consumer's baseline, so it is pinned.
test('the provider id is stable', () => {
  expect(RESOLVE_ID).toBe('agent-resolve')
})
