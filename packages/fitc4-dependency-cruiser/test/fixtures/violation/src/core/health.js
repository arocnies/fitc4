// The boundary violation under test: core reaches into interface while the
// model only declares interface -> core.
const { fmt } = require('../interface/format.js')

module.exports.health = function health() {
  return fmt('ok')
}
