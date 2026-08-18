const { health } = require('../core/health.js')

module.exports.status = function status() {
  return health()
}
