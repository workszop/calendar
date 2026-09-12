import { withLambda, type HandlerResponse } from '@netlify/aws-lambda-compat';
import { getStore } from '@netlify/blobs';
import serverless from 'serverless-http';
import { createApi } from '../../server/api';
import { createBlobPollStore } from '../../server/blob-store';

const STORE_NAME = 'calendar-polls';
const FUNCTION_PATH = '/.netlify/functions/api';

// The native runtime supplies Blobs credentials and its uncached endpoint.
// Do not use legacy connectLambda: it discards the strong-read configuration.
export default withLambda(async (event, context): Promise<HandlerResponse> => {
  try {
    const isPreview = process.env.CONTEXT === 'deploy-preview' || process.env.CONTEXT === 'branch-deploy';
    if (isPreview && !process.env.DEPLOY_ID) throw new Error('Preview deploy ID is missing');
    const name = isPreview ? `${STORE_NAME}-${process.env.DEPLOY_ID}` : STORE_NAME;
    const blobs = getStore({ name, consistency: 'strong' });
    const app = createApi(createBlobPollStore(blobs));
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
