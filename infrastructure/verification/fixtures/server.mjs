// Synthetic example only. Upload as app/server.mjs for the registered fixtures.
import { createServer } from 'node:http';
const orders = new Map();
const server = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  try {
    if (req.method === 'GET' && req.url === '/health') { res.end(JSON.stringify({ ok: true })); return; }
    if (req.method === 'GET' && req.url === '/integration/balance') {
      let response = await fetch(`${process.env.PAYMENTS_URL}/v1/balance`);
      if (response.status === 429) response = await fetch(`${process.env.PAYMENTS_URL}/v1/balance`);
      const value = await response.json();
      if (!response.ok || value.livemode !== false || value.available?.[0]?.currency !== 'usd' || typeof value.available[0].amount !== 'number') throw new Error('provider');
      res.end(JSON.stringify({ amount: value.available[0].amount, currency: 'usd', testMode: true })); return;
    }
    if (req.method === 'POST' && req.url === '/checkout') {
      let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 8192) throw new Error('limit'); }
      const input = JSON.parse(text); const total = input.cart.reduce((sum, item) => sum + item.quantity * item.unitAmount, 0);
      if (orders.has(input.idempotencyKey)) { res.end(JSON.stringify(orders.get(input.idempotencyKey))); return; }
      const response = await fetch(`${process.env.PAYMENTS_URL}/v1/payment_intents`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey }, body: JSON.stringify({ amount: total, currency: 'usd', payment_method: input.paymentToken }) });
      const value = await response.json();
      if (response.status === 402) { res.statusCode = 402; res.end(JSON.stringify({ status: 'declined' })); return; }
      if (!response.ok || value.livemode !== false || value.status !== 'succeeded') throw new Error('provider');
      const order = { status: 'paid', total, orderId: 'synthetic-order' }; orders.set(input.idempotencyKey, order); res.end(JSON.stringify(order)); return;
    }
    res.statusCode = 404; res.end('{}');
  } catch { res.statusCode = 502; res.end(JSON.stringify({ error: 'provider_invalid' })); }
});
server.listen(Number(process.env.PORT), process.env.HOST);
