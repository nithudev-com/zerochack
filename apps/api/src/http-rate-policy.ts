/** Session checks have a separate bounded bucket from application requests. */
export function authMeRateLimit(nodeEnv: 'development' | 'test' | 'production') {
  return { max: nodeEnv === 'test' ? 10_000 : 100, timeWindow: '1 minute' };
}
