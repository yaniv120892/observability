import { checkLiveness, createDeepHealthCheck, HEALTH_RESPONSE_HEADERS } from '../health.js';
import type { DeepHealthCheckOptions } from '../health.types.js';

export function healthRoute(): Response {
  const { body, httpStatus } = checkLiveness();
  return Response.json(body, { status: httpStatus, headers: HEALTH_RESPONSE_HEADERS });
}

export function createDeepHealthRoute(options: DeepHealthCheckOptions): () => Promise<Response> {
  const check = createDeepHealthCheck(options);
  return async function deepHealthRoute() {
    const { body, httpStatus } = await check();
    return Response.json(body, { status: httpStatus, headers: HEALTH_RESPONSE_HEADERS });
  };
}
