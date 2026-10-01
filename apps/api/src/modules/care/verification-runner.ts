import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { VERIFICATION_POLICY, type VerificationToolId } from '@zerochack/care';
import type { Environment } from '@zerochack/config';
import { ApiError } from '../../errors.js';

export type VerificationInput = { policy: typeof VERIFICATION_POLICY; toolId: VerificationToolId; files: Array<{ path: string; content: string }>; baseline?: Array<{ path: string; content: string }> };
export const verificationResultSchema = z.object({
  policy: z.literal(VERIFICATION_POLICY), toolId: z.string(), nodeVersion: z.string().max(40),
  outcome: z.enum(['PASSED','FAILED','OBSERVED','PREPARED']),
  checks: z.array(z.object({ name: z.string().max(180), passed: z.boolean() }).strict()).min(1).max(100),
  metrics: z.record(z.string(), z.unknown()).optional(), limitations: z.array(z.string().max(1000)).min(1).max(10),
  candidateFiles: z.array(z.object({ path: z.string(), content: z.string() }).strict()).min(1).max(30).optional()
}).strict();
export type VerificationResult = z.infer<typeof verificationResultSchema>;
export type VerificationAdapter = (input: VerificationInput, environment: Environment) => Promise<VerificationResult>;
export function containerArguments(image: string, name: string) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image) || !/^care-verify-[a-f0-9-]{36}$/.test(name)) throw new ApiError(503, 'VERIFICATION_IMAGE_REQUIRED', 'Configure a reviewed immutable local runner image.');
  return ['run', '--rm', '--interactive', '--pull=never', `--name=${name}`, '--network=none', '--http-proxy=false', '--read-only', '--read-only-tmpfs=false', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65532:65532', '--pids-limit=64', '--memory=256m', '--memory-swap=256m', '--cpus=1', '--timeout=50', '--ulimit=nofile=256:256', '--ulimit=core=0:0', '--tmpfs=/work:rw,nosuid,nodev,noexec,size=64m,mode=1777', '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777', '--env=HOME=/tmp', '--env=TZ=UTC', '--env=NODE_NO_WARNINGS=1', '--workdir=/work', '--entrypoint=node', image, '/opt/runner/worker.mjs'];
}
function podman(args: string[], input = '', timeout = 8000, limit = 550000): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    // Explicitly omit application secrets, proxy credentials and remote-engine configuration.
    const child = spawn('/usr/bin/podman', ['--remote=false', ...args], { env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, LANG: 'C.UTF-8' }, stdio: ['pipe','pipe','pipe'] });
    const chunks: Buffer[] = []; let size = 0; let settled = false;
    const finish = (error?: Error, code = -1) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { child.kill('SIGKILL'); reject(error); } else resolve({ code, text: Buffer.concat(chunks).toString('utf8') }); };
    const timer = setTimeout(() => finish(new ApiError(504, 'VERIFICATION_TIMEOUT', 'The isolated runner exceeded its deadline.')), timeout);
    child.on('error', () => finish(new ApiError(503, 'VERIFICATION_RUNTIME_REQUIRED', 'The rootless Podman runtime is unavailable.')));
    child.stdout.on('data', (bytes: Buffer) => { size += bytes.length; if (size > limit) finish(new ApiError(502, 'VERIFICATION_OUTPUT_LIMIT', 'The runner exceeded its result limit.')); else chunks.push(bytes); });
    child.stderr.on('data', (bytes: Buffer) => { size += bytes.length; if (size > limit) finish(new ApiError(502, 'VERIFICATION_OUTPUT_LIMIT', 'The runner exceeded its output limit.')); });
    child.on('close', (code) => finish(undefined, code ?? -1));
    child.stdin.on('error', () => { /* close/error determines the saved outcome */ }); child.stdin.end(input);
  });
}
export async function verificationPreflight(env: Environment) {
  if (process.platform !== 'linux' || !process.getuid || process.getuid() === 0) throw new ApiError(503, 'VERIFICATION_ROOTLESS_REQUIRED', 'Use a non-root Linux service with rootless Podman and cgroup v2 resource delegation.');
  if (!env.CARE_VERIFICATION_IMAGE || !/^sha256:[a-f0-9]{64}$/.test(env.CARE_VERIFICATION_IMAGE)) throw new ApiError(503, 'VERIFICATION_IMAGE_REQUIRED', 'A reviewed local runner image digest is required.');
  const runtime = await podman(['info', '--format=json']);
  let info: { host?: { security?: { rootless?: boolean; seccompEnabled?: boolean }; cgroupVersion?: string; cgroupControllers?: string[] } };
  try { info = JSON.parse(runtime.text) as typeof info; } catch { throw new ApiError(503, 'VERIFICATION_RUNTIME_REQUIRED', 'The runner runtime is unavailable.'); }
  if (runtime.code || !info.host?.security?.rootless || !info.host.security.seccompEnabled || info.host.cgroupVersion !== 'v2' || !['cpu','memory','pids'].every((controller) => info.host?.cgroupControllers?.includes(controller))) throw new ApiError(503, 'VERIFICATION_ISOLATION_REQUIRED', 'Rootless mode, seccomp and delegated CPU, memory and process limits are required.');
  const image = await podman(['image', 'inspect', env.CARE_VERIFICATION_IMAGE]);
  const inspected = z.array(z.object({ Id: z.string(), Config: z.object({ Env: z.array(z.string()).optional() }) })).length(1).safeParse((() => { try { return JSON.parse(image.text) as unknown; } catch { return null; } })());
  if (image.code || !inspected.success || inspected.data[0]!.Id.replace(/^sha256:/, '') !== env.CARE_VERIFICATION_IMAGE.slice(7) || inspected.data[0]!.Config.Env?.some((value) => value.startsWith('ZEROCHACK_TEST_IMAGE='))) throw new ApiError(503, 'VERIFICATION_IMAGE_REQUIRED', 'Install the exact reviewed production image; synthetic test images are not accepted.');
  return { image: env.CARE_VERIFICATION_IMAGE, isolation: 'ROOTLESS_OFFLINE_CGROUP_V2' };
}
let active = false;
export const runVerification: VerificationAdapter = async (input, env) => {
  if (active) throw new ApiError(409, 'VERIFICATION_BUSY', 'This verification worker is already occupied.');
  active = true;
  const name = `care-verify-${randomUUID()}`;
  try {
    const ready = await verificationPreflight(env);
    const response = await podman(containerArguments(ready.image, name), JSON.stringify(input), 55000);
    let value: unknown;
    try { value = JSON.parse(response.text); } catch { throw new ApiError(502, 'VERIFICATION_RESULT_INVALID', 'The isolated runner did not return a valid result.'); }
    if (response.code !== 0) {
      const checked = z.object({ error: z.string().regex(/^[A-Z_]{1,80}$/) }).strict().safeParse(value);
      throw new ApiError(502, checked.success ? checked.data.error : 'VERIFICATION_FAILED', 'The profile could not complete. Its failure is retained.');
    }
    const checked = verificationResultSchema.safeParse(value);
    if (!checked.success || checked.data.toolId !== input.toolId || Boolean(checked.data.candidateFiles) !== (input.toolId === 'T43')) throw new ApiError(502, 'VERIFICATION_RESULT_INVALID', 'The runner returned inconsistent evidence.');
    return checked.data;
  } finally { await podman(['rm', '--force', '--ignore', name], '', 5000, 10000).catch(() => undefined); active = false; }
};
