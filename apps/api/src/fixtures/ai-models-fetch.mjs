// Synthetic CLI integration fixture only. No provider network or paid generations.
globalThis.fetch = async input => {
  const url = new URL(String(input));
  if (url.origin !== 'https://api.anthropic.com' || url.pathname !== '/v1/models/claude-synthetic-fixture') throw new Error('Fixture rejects external requests');
  return new Response(JSON.stringify({ id: 'claude-synthetic-fixture' }), { status: 200, headers: { 'content-type': 'application/json' } });
};
