const { greet } = require('../lib.js')

if (greet('test') !== 'hello test') {
  throw new Error('greet is broken')
}
