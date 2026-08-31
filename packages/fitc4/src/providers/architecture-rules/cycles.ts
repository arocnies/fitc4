/**
 * `circular-dependency`: the code exercises a dependency cycle between model
 * elements, and every edge of the cycle is declared.
 *
 * The scoping is what makes this rule say something no other rule says. A
 * cycle containing an UNDECLARED edge already fails through
 * `missing-relationship` on that edge, so repeating it here would report one
 * defect twice. A cycle whose every edge is declared and exercised passes
 * every per-edge rule quietly — each crossing matches the contract — and the
 * cycle itself is the only fact left unstated. This rule states it.
 *
 * One finding per strongly connected component, not per elementary cycle: a
 * tangle of six elements can contain dozens of elementary cycles, and a
 * finding per cycle buries the one decision (untangle these six) under
 * arithmetic. The description carries one witness cycle so the finding is
 * concrete, and `related` carries every member.
 */

import { findingId } from '../../ids.ts'
import { PROVIDER_ID, type Finding, type SeverityOf } from './shared.ts'

/** One exercised, declared element-level edge, deduplicated by the caller. */
export interface DeclaredEdge {
  source: string
  target: string
}

export function circularDependencyRules(
  edges: Iterable<DeclaredEdge>,
  severityOf: SeverityOf,
): Finding[] {
  const graph = new Map<string, Set<string>>()
  for (const edge of edges) {
    if (edge.source === edge.target) continue
    const targets = graph.get(edge.source) ?? new Set<string>()
    targets.add(edge.target)
    graph.set(edge.source, targets)
    if (!graph.has(edge.target)) graph.set(edge.target, new Set())
  }

  const findings: Finding[] = []
  for (const component of stronglyConnected(graph)) {
    if (component.length < 2) continue
    const members = [...component].sort()
    const witness = witnessCycle(graph, new Set(members))
    findings.push({
      id: findingId(PROVIDER_ID, 'circular-dependency', members.join('->')),
      ruleId: 'circular-dependency',
      severity: severityOf('circular-dependency', 'warning'),
      description:
        `${witness.join(' -> ')}: the code exercises a dependency cycle, and the model ` +
        `declares every edge of it. Break the cycle in the code, or keep it as a deliberate ` +
        `design with this rule tuned down.`,
      subject: { kind: 'element', id: members[0] ?? '' },
      related: members.map((id) => ({ kind: 'element', id })),
      provider: PROVIDER_ID,
    })
  }
  return findings
}

/**
 * Tarjan's algorithm, iterative so a deep chain cannot overflow the stack.
 * Returns every strongly connected component; the caller keeps the cyclic
 * ones (size >= 2 — self-loops were excluded when the graph was built).
 */
function stronglyConnected(graph: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>()
  const lowLink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  for (const start of graph.keys()) {
    if (index.has(start)) continue
    // Each frame: the node and an iterator over its successors, so the walk
    // resumes exactly where it left off when a child frame completes.
    const frames: { node: string; successors: Iterator<string> }[] = []
    const push = (node: string): void => {
      index.set(node, counter)
      lowLink.set(node, counter)
      counter += 1
      stack.push(node)
      onStack.add(node)
      frames.push({ node, successors: (graph.get(node) ?? new Set()).values() })
    }
    push(start)
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]
      if (frame === undefined) break
      const next = frame.successors.next()
      if (!next.done) {
        const successor = next.value
        if (!index.has(successor)) {
          push(successor)
        } else if (onStack.has(successor)) {
          lowLink.set(
            frame.node,
            Math.min(lowLink.get(frame.node) ?? 0, index.get(successor) ?? 0),
          )
        }
        continue
      }
      frames.pop()
      const parent = frames[frames.length - 1]
      if (parent !== undefined) {
        lowLink.set(
          parent.node,
          Math.min(lowLink.get(parent.node) ?? 0, lowLink.get(frame.node) ?? 0),
        )
      }
      if (lowLink.get(frame.node) === index.get(frame.node)) {
        const component: string[] = []
        for (;;) {
          const node = stack.pop()
          if (node === undefined) break
          onStack.delete(node)
          component.push(node)
          if (node === frame.node) break
        }
        components.push(component)
      }
    }
  }
  return components
}

/**
 * One concrete cycle inside the component, starting from its alphabetically
 * first member so the description is stable across runs: `a -> b -> a`.
 *
 * A shortest path back to the start, by BFS over the component's own edges
 * with successors expanded in sorted order, so the witness is deterministic
 * AND every edge it names is real. The first cut greedily walked
 * sorted-first successors and closed the path wherever it dead-ended, which
 * fabricated the closing edge on any component where the walk could strand
 * itself — first hit on a fifteen-service compose stack whose walk entered a
 * spur (`flagd-ui`) that only led back to already-visited members. A witness
 * naming an edge the model never declared is worse than no witness: it sends
 * the reader hunting for a dependency that does not exist.
 */
function witnessCycle(graph: Map<string, Set<string>>, members: Set<string>): string[] {
  const start = [...members].sort()[0] ?? ''
  const successorsOf = (node: string): string[] =>
    [...(graph.get(node) ?? [])].filter((candidate) => members.has(candidate)).sort()

  const parent = new Map<string, string>()
  const queue: string[] = []
  const enqueue = (node: string, from: string): void => {
    if (node === start || parent.has(node)) return
    parent.set(node, from)
    queue.push(node)
  }
  for (const successor of successorsOf(start)) enqueue(successor, start)

  for (let at = 0; at < queue.length; at += 1) {
    const node = queue[at]
    if (node === undefined) break
    for (const successor of successorsOf(node)) {
      if (successor === start) {
        const path = [node]
        let current = node
        while (current !== start) {
          current = parent.get(current) ?? start
          path.push(current)
        }
        path.reverse()
        path.push(start)
        return path
      }
      enqueue(successor, node)
    }
  }
  // Unreachable: a strongly connected component of two or more members always
  // holds a cycle through each member. Stay total anyway.
  return [start, start]
}
