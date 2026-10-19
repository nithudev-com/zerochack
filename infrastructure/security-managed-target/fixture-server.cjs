'use strict';

// DISPOSABLE FIXTURE ONLY. Not a production sshd and not registered by Compose/API/worker.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { timingSafeEqual } = require('node:crypto');
const { Server, utils } = require('ssh2');
const { COMMAND } = require('./broker.cjs');
const clients = new Set(); const children = new Set();
function protectedFile(name, mode, maximum = 16384) {
  const fd = fs.openSync(`/run/managed-target-fixture/${name}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o7777) !== mode || info.size > maximum) throw new Error('FIXTURE_IDENTITY_INVALID');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
if (process.getuid() !== 0 || process.env.MANAGED_TARGET_DISPOSABLE_FIXTURE !== '1') throw new Error('FIXTURE_ONLY');
const allowed = utils.parseKey(protectedFile('client.pub', 0o400));
if (allowed instanceof Error || Array.isArray(allowed)) throw new Error('FIXTURE_IDENTITY_INVALID');
const publicKey = allowed.getPublicSSH();
const dropAck = process.env.MANAGED_TARGET_FIXTURE_DROP_COMMIT_ACK === '1';
const server = new Server({ hostKeys: [protectedFile('host.key', 0o400)] }, (client) => {
  if (clients.size >= 2) { client.end(); return; }
  clients.add(client);
  const authTimer = setTimeout(() => client.end(), 5000);
  const lifetime = setTimeout(() => client.end(), 40000);
  client.on('error', () => {});
  client.on('close', () => { clearTimeout(authTimer); clearTimeout(lifetime); clients.delete(client); });
  client.on('authentication', (ctx) => {
    if (ctx.method !== 'publickey' || ctx.username !== 'codebandage-managed-target' || ctx.key.algo !== allowed.type ||
      ctx.key.data.length !== publicKey.length || !timingSafeEqual(ctx.key.data, publicKey) ||
      (ctx.signature && allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true)) return ctx.reject();
    ctx.accept();
  });
  client.on('ready', () => {
    clearTimeout(authTimer);
    let used = false;
    client.on('request', (_accept, reject) => reject?.()); // No global forwarding requests.
    client.on('tcpip', (_accept, reject) => reject());
    client.on('openssh.streamlocal', (_accept, reject) => reject());
    client.on('session', (accept, reject) => {
      if (used) return reject();
      used = true;
      const session = accept();
      let executed = false;
      for (const event of ['pty','shell','subsystem','sftp','env','x11','auth-agent']) session.on(event, (_accept, deny) => deny?.());
      session.on('exec', (allow, deny, info) => {
        if (executed || info.command !== COMMAND) return deny();
        executed = true;
        const stream = allow();
        const child = spawn('/usr/bin/python3', ['-I','-B','/opt/managed-target/helper.py'], {
          shell: false, detached: true, stdio: ['pipe','pipe','pipe'],
          env: { PATH: '/usr/local/bin:/usr/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' }
        });
        children.add(child);
        let input = ''; let bytes = 0; let output = 0; let errors = 0; let completed = false; const pendingOutput = [];
        function stop() { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
        const timer = setTimeout(() => { stop(); stream.destroy(); }, 28000);
        stream.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 32768) { stop(); stream.destroy(); return; }
          input += chunk.toString('utf8');
          child.stdin.write(chunk);
        });
        stream.on('end', () => child.stdin.end());
        stream.on('error', () => stop());
        stream.on('close', () => { if (!completed) stop(); });
        child.stdin.on('error', () => {});
        child.stdout.on('data', (chunk) => {
          output += chunk.length;
          let commit = false; let recoveryExport = false;
          try { const request = JSON.parse(input); commit = request.command === 'COMMIT'; recoveryExport = request.command === 'EXPORT_RECOVERY'; } catch {}
          if (output > (recoveryExport ? 524288 + 32768 : 32768)) { stop(); stream.destroy(); return; }
          if (dropAck && commit) pendingOutput.push(chunk); else stream.write(chunk);
        });
        child.stderr.on('data', (chunk) => { errors += chunk.length; if (errors > 1024) { stop(); stream.destroy(); } });
        child.on('error', () => { stop(); stream.destroy(); });
        child.on('close', (code) => {
          completed = true; children.delete(child); clearTimeout(timer);
          let commit = false;
          try { commit = JSON.parse(input).command === 'COMMIT'; } catch {}
          if (dropAck && commit && code === 0) { client.end(); return; }
          for (const chunk of pendingOutput) stream.write(chunk);
          stream.exit(code === 0 ? 0 : 2); stream.end();
        });
      });
    });
  });
});
server.maxConnections = 2;
server.listen(2222, '0.0.0.0', () => process.stdout.write('MANAGED_TARGET_DISPOSABLE_FIXTURE_READY\n'));
function shutdown() {
  for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 1000).unref();
}
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
