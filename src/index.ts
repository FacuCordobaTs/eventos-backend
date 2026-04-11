import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { tenantsRoute } from './routes/tenants'

const app = new Hono()

app.use(logger())

app.route('/tenants', tenantsRoute)

export default app
