// A second import site of the stripe package, through a subpath: the
// agent-resolve tests pin that both sites collapse into ONE candidate
// decision and fan back out to two associations on acceptance.
import webhooks from 'stripe/webhooks'

export const wiredMore = [webhooks]
