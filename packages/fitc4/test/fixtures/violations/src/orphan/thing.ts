// An unowned file that imports owned code, so the ownership-advisor tests can
// pin the neighborhood lines (imports annotated with their owning element).
// The body is deliberately longer than 2,000 characters of code so the
// advisor's excerpt-size assertions compare a real cap, not a file that fits
// either way.
import { health } from '../core/health.js'

export const thing = 'orphan'

export function orphanStatus(): string {
  return `orphan reports ${health()}`
}

export interface OrphanRecord {
  id: string
  label: string
  createdAt: number
  updatedAt: number
  tags: string[]
}

export function makeRecord(id: string, label: string): OrphanRecord {
  const now = Date.now()
  return { id, label, createdAt: now, updatedAt: now, tags: [] }
}

export function tagRecord(record: OrphanRecord, tag: string): OrphanRecord {
  if (record.tags.includes(tag)) return record
  return { ...record, tags: [...record.tags, tag], updatedAt: Date.now() }
}

export function untagRecord(record: OrphanRecord, tag: string): OrphanRecord {
  if (!record.tags.includes(tag)) return record
  return { ...record, tags: record.tags.filter((entry) => entry !== tag), updatedAt: Date.now() }
}

export function renameRecord(record: OrphanRecord, label: string): OrphanRecord {
  return { ...record, label, updatedAt: Date.now() }
}

export function summarize(records: OrphanRecord[]): string {
  const labels = records.map((record) => record.label).sort()
  return `${records.length} records: ${labels.join(', ')}`
}

export function newestFirst(records: OrphanRecord[]): OrphanRecord[] {
  return [...records].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function findByTag(records: OrphanRecord[], tag: string): OrphanRecord[] {
  return records.filter((record) => record.tags.includes(tag))
}

export function mergeRecords(base: OrphanRecord, extra: OrphanRecord): OrphanRecord {
  const tags = [...new Set([...base.tags, ...extra.tags])].sort()
  return {
    ...base,
    label: extra.label || base.label,
    tags,
    updatedAt: Math.max(base.updatedAt, extra.updatedAt),
  }
}

export function pruneRecords(records: OrphanRecord[], keep: number): OrphanRecord[] {
  if (keep <= 0) return []
  return newestFirst(records).slice(0, keep)
}

export function recordAges(records: OrphanRecord[], now: number): Map<string, number> {
  const ages = new Map<string, number>()
  for (const record of records) {
    ages.set(record.id, Math.max(0, now - record.createdAt))
  }
  return ages
}
