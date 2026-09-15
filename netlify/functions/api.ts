import { withLambda, type HandlerResponse } from '@netlify/aws-lambda-compat';
import serverless from 'serverless-http';
import { createApi } from '../../server/api';
import { createNetlifyPollStore } from '../../server/netlify-store';
import { createRateLimiter, netlifyClientIp, rateLimitsFromEnv } from '../../server/rate-limit';

const FUNCTION_PATH = '/.netlify/functions/api';

// The app is rebuilt per request, but the limiter lives as long as this warm
// instance, so per-IP counts survive between requests it serves.
const rateLimiter = createRateLimiter(rateLimitsFromEnv());

// The native runtime supplies Blobs credentials and its uncached endpoint.
// Do not use legacy connectLambda: it discards the strong-read configuration.
export default withLambda(async (event, context): Promise<HandlerResponse> => {
  try {
    const app = createApi(createNetlifyPollStore(), { rateLimit: rateLimiter, clientIp: netlifyClientIp });
    const path = event.path === FUNCTION_PATH || event.path.startsWith(`${FUNCTION_PATH}/`)
      ? `/api${event.path.slice(FUNCTION_PATH.length)}`
      : event.path;
    return await serverless(app)({ ...event, path }, context) as HandlerResponse;
  } catch {
    console.error('Netlify meeting API initialization failed');
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'Meeting storage is unavailable. Please try again later.' }),
    };
  }
});

// The platform rate limit in front of every instance lives on the /api/* redirect
// in netlify.toml: Netlify only applies a function's own `config.rateLimit`
// together with a `path`, and this function is reached through that redirect.
