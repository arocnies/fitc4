export type Status = 'ok'

export interface Shape {
  status: Status
}

export function health(): Status {
  return 'ok'
}
