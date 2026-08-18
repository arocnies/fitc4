import Stripe from 'stripe'
import amqp from 'amqplib'
import missing from './missing.js'

import { util } from './util.js'

export const wired = [Stripe, amqp, missing, util]
