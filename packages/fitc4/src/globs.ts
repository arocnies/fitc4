/**
 * The one path-pattern grammar the providers share.
 *
 * `*` matches within a path segment, `**` across segments, and a bare path
 * matches itself or its directory subtree. Those are the same prefix
 * semantics `sources` metadata uses, so a pattern in a config reads like the
 * rest of the model's path vocabulary. Deliberately no glob dependency: this
 * is the whole grammar, and both the agent scanner's `focus` and the import
 * crawler's `ignore` are it, so a user learns it once.
 */

/**
 * Compile patterns into a predicate over repository-relative POSIX paths.
 *
 * `label` names the option in the error messages, because a pattern that
 * cannot match anything is a config typo and the config is where the fix is.
 */
export function pathMatcher(patterns: string[], label: string): (path: string) => boolean {
  if (patterns.length === 0) {
    throw new Error(`${label} is empty; list at least one glob or path`)
  }

  const tests = patterns.map((pattern) => {
    const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (normalized === '') {
      throw new Error(`${label} pattern '${pattern}' matches nothing it could name`)
    }
    if (!normalized.includes('*')) {
      return (file: string) => file === normalized || file.startsWith(`${normalized}/`)
    }
    const regExp = globToRegExp(normalized)
    return (file: string) => regExp.test(file)
  })

  return (file) => tests.some((test) => test(file))
}

function globToRegExp(glob: string): RegExp {
  let pattern = ''
  let index = 0
  while (index < glob.length) {
    if (glob.startsWith('**/', index)) {
      pattern += '(?:[^/]+/)*'
      index += 3
      continue
    }
    if (glob.startsWith('**', index)) {
      pattern += '.*'
      index += 2
      continue
    }
    const char = glob[index] ?? ''
    if (char === '*') {
      pattern += '[^/]*'
      index += 1
      continue
    }
    pattern += /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char
    index += 1
  }
  return new RegExp(`^${pattern}$`)
}
