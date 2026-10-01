import { createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { SmtpEmailProvider } from './index.js';

// Fixed loopback SMTP fixture only; no external mail server or recipient is contacted.
async function fixture(rejectRecipient: boolean, action: (port: number, messages: string[]) => Promise<void>) {
  const sockets = new Set<Socket>(); const messages: string[] = [];
  const server = createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => undefined);
    socket.setEncoding('utf8'); socket.write('220 fixture.example.test ESMTP\r\n');
    let buffer = ''; let data = false; let message = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length + message.length > 65536) { socket.destroy(); return; }
      let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') { messages.push(message); message = ''; data = false; socket.write('250 accepted\r\n'); }
          else message += line + '\r\n';
        } else if (/^EHLO /i.test(line)) socket.write('250-fixture.example.test\r\n250 SIZE 65536\r\n');
        else if (/^MAIL FROM:/i.test(line)) socket.write('250 sender accepted\r\n');
        else if (/^RCPT TO:/i.test(line)) socket.write(rejectRecipient ? '550 synthetic recipient rejected\r\n' : '250 recipient accepted\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 end with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 closing\r\n');
        else socket.write('500 unsupported fixture command\r\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try { const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture'); await action(address.port, messages); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
describe('SMTP transport compatibility with the patched mailer', () => {
  it('delivers the synthetic message and retains its idempotency message ID', () => fixture(false, async (port, messages) => {
    const provider = new SmtpEmailProvider({ host: '127.0.0.1', port, secure: false, from: 'sender@example.test' });
    const result = await provider.send({ to: 'recipient@example.test', subject: 'Synthetic fixture', text: 'Synthetic delivery check', idempotencyKey: 'synthetic-1' });
    expect(result.providerMessageId).toBe('<synthetic-1@zerochack.delivery>');
    expect(messages).toHaveLength(1); expect(messages[0]).toContain('Subject: Synthetic fixture'); expect(messages[0]).toContain('Synthetic delivery check');
  }));
  it('reports a rejected synthetic recipient as a failure', () => fixture(true, async (port, messages) => {
    const provider = new SmtpEmailProvider({ host: '127.0.0.1', port, secure: false, from: 'sender@example.test' });
    await expect(provider.send({ to: 'recipient@example.test', subject: 'Synthetic fixture', text: 'Synthetic rejection check' })).rejects.toMatchObject({ responseCode: 550 });
    expect(messages).toHaveLength(0);
  }));
});
