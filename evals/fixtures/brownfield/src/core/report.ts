import fs from 'node:fs'

import { orderTotalCents, type Order } from './orders.js'

export function writeDailyReport(orders: Order[], reportPath: string): void {
  const lines = orders.map((order) => `${order.id}\t${orderTotalCents(order)}`)
  fs.writeFileSync(reportPath, lines.join('\n'))
}
