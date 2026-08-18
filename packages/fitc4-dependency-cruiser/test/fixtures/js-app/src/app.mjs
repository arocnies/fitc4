import { greet } from './lib.js'
import { join } from 'node:path'

export function main() {
  return join('greetings', greet('world'))
}

export async function lazy() {
  const { greet: lazyGreet } = await import('./lib.js')
  return lazyGreet('later')
}
