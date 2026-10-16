import nodemailer from 'nodemailer';
import { emailLogoBase64 } from './brand-asset.js';

export type MonitoringEmail = { state: 'DOWN' | 'RECOVERED' | 'UNKNOWN'; websiteId: string; websiteName: string; websiteHost: string; checkedAt: string; outageStartedAt: string | null; httpStatus: number | null; recent: Array<'UP' | 'DOWN' | 'UNKNOWN'>; overviewUrl: string };
export interface EmailMessage { to: string; subject: string; text: string; idempotencyKey?: string; monitoring?: MonitoringEmail; }
export interface EmailProvider { send(message: EmailMessage): Promise<{ providerMessageId: string }>; }
export type SmtpOptions = { host: string; port: number; secure: boolean; user?: string; password?: string; from: string; fromName?: string; servername?: string; requireTLS?: boolean };

const placeholder = /\{\{\s*([a-zA-Z][a-zA-Z0-9.]*)\s*\}\}/gu;
const forbidden = /(?:\{\{\{|\}\}\}|<%|%>|<script\b|javascript:|\$\{)/iu;

export function validateEmailTemplate(value: string, maximum: number): string {
  if (!value.trim() || value.length > maximum || forbidden.test(value)) throw new Error('EMAIL_TEMPLATE_INVALID');
  const withoutPlaceholders = value.replace(placeholder, '');
  if (withoutPlaceholders.includes('{{') || withoutPlaceholders.includes('}}')) throw new Error('EMAIL_TEMPLATE_INVALID');
  return value;
}

export function renderEmailTemplate(value: string, data: Record<string, unknown>, maximum = 20_000): string {
  validateEmailTemplate(value, maximum);
  return value.replace(placeholder, (_match, path: string) => {
    const result = path.split('.').reduce<unknown>((current, key) => typeof current === 'object' && current !== null && !Array.isArray(current) ? (current as Record<string, unknown>)[key] : undefined, data);
    if (!['string', 'number', 'boolean'].includes(typeof result)) throw new Error(`EMAIL_TEMPLATE_VALUE_MISSING:${path}`);
    return String(result);
  });
}


function escapeEmailHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}
export function renderBrandedEmail(text: string): string {
  return `<!doctype html><html lang="en"><body style="margin:0;padding:24px;background:#f8fafc;color:#172033;font:16px/1.6 Arial,sans-serif"><table role="presentation" style="max-width:600px;width:100%;margin:auto;border-collapse:collapse"><tr><td style="padding:20px 0"><img src="cid:codebandage-logo" width="300" height="60" alt="CodeBandage" style="display:block;max-width:100%;height:auto" /></td></tr><tr><td style="padding:24px 0;white-space:pre-wrap">${escapeEmailHtml(text)}</td></tr><tr><td style="border-top:1px solid #d8dee8;padding-top:16px;color:#536174">CodeBandage · AI Website Security &amp; Repair</td></tr></table></body></html>`;
}

export function monitoringEmailData(payload: unknown, appUrl: string): MonitoringEmail | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const value = payload as Record<string, unknown>;
  if (!['DOWN', 'RECOVERED', 'UNKNOWN'].includes(String(value.state)) || typeof value.websiteId !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.websiteId) || typeof value.websiteName !== 'string' || typeof value.websiteHost !== 'string' || typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))) return undefined;
  const origin = new URL(appUrl); if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('MONITORING_EMAIL_ORIGIN_INVALID');
  const recent = Array.isArray(value.recent) ? value.recent.filter((state): state is 'UP' | 'DOWN' | 'UNKNOWN' => ['UP', 'DOWN', 'UNKNOWN'].includes(String(state))).slice(-12) : [];
  return { state: value.state as MonitoringEmail['state'], websiteId: value.websiteId, websiteName: value.websiteName.slice(0, 200), websiteHost: value.websiteHost.slice(0, 253), checkedAt: new Date(value.checkedAt).toISOString(), outageStartedAt: typeof value.outageStartedAt === 'string' && Number.isFinite(Date.parse(value.outageStartedAt)) ? new Date(value.outageStartedAt).toISOString() : null, httpStatus: typeof value.httpStatus === 'number' && Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : null, recent, overviewUrl: new URL(`/customer/overview?website=${encodeURIComponent(value.websiteId)}`, origin.origin).toString() };
}

export function renderMonitoringEmail(data: MonitoringEmail, text = ''): string {
  const up = data.state === 'RECOVERED'; const down = data.state === 'DOWN'; const color = up ? '#167347' : down ? '#b42318' : '#75520c'; const tint = up ? '#ecfdf3' : down ? '#fef3f2' : '#fffaeb';
  const title = up ? 'Your website is responding again' : down ? 'Downtime detected' : 'Monitoring needs attention';
  const bars = data.recent.map(state => `<td style="padding:2px"><div style="height:28px;background:${state === 'UP' ? '#167347' : state === 'DOWN' ? '#b42318' : '#7a879a'};border-radius:4px">&nbsp;</div></td>`).join('');
  const duration = up && data.outageStartedAt ? Math.max(0, Math.round((Date.parse(data.checkedAt) - Date.parse(data.outageStartedAt)) / 60000)) : null;
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:24px 12px;background:#f3f6fb;font:16px/1.6 Arial,sans-serif;color:#173153"><table role="presentation" style="width:100%;max-width:600px;margin:auto;border-collapse:collapse"><tr><td style="padding:16px"><img src="cid:codebandage-logo" alt="CodeBandage" width="300" height="60" style="display:block;max-width:100%;height:auto"></td></tr><tr><td style="background:#ffffff;border-radius:16px;padding:28px"><p style="margin:0 0 12px;color:${color};font-size:13px;font-weight:bold">${up ? '✓ RECOVERY' : down ? '! DOWNTIME' : '! CHECK UNAVAILABLE'}</p><h1 style="margin:0;font-size:28px;line-height:1.25">${title}</h1><h2 style="font-size:19px;margin-bottom:0">${escapeEmailHtml(data.websiteName)}</h2><p style="margin-top:0;color:#53647d">${escapeEmailHtml(data.websiteHost)}</p><table role="presentation" style="width:100%;background:${tint};border-radius:10px"><tr><td style="padding:16px;color:${color}"><strong>${up ? 'UP · Successful HTTP response' : down ? 'DOWN · Failed availability check' : 'UNKNOWN · No availability conclusion'}</strong><br>HTTP: ${data.httpStatus ?? 'No response'}<br>Checked: ${escapeEmailHtml(data.checkedAt)}${duration !== null ? `<br>Observed incident window: about ${duration} minutes` : ''}</td></tr></table><h3 style="font-size:15px;margin-bottom:8px">Recent observed checks</h3><table role="presentation" style="width:100%"><tr>${bars || '<td>No earlier samples</td>'}</tr></table><p style="font-size:12px;color:#53647d">Green: up · Red: down · Grey: unknown<br>This graphic shows saved samples, not continuous coverage or an uptime SLA. Recovery and incident times are first-observed check times.</p><p><a href="${escapeEmailHtml(data.overviewUrl)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#175cd3;color:white;text-decoration:none;font-weight:bold">View website history →</a></p><p style="font-size:13px;color:#53647d">${down ? 'Review the history before making changes. One failed probe does not identify the cause or prove that every visitor is affected.' : up ? 'A successful response was observed. This does not certify that all website features are working.' : 'The monitor could not safely complete its check. Your website has not been declared down.'}</p>${text ? `<p style="white-space:pre-wrap;font-size:13px;color:#53647d">${escapeEmailHtml(text)}</p>` : ''} </td></tr><tr><td style="padding:20px 16px;color:#53647d;font-size:12px">CodeBandage · Website reliability<br>Manage monitoring email preferences in your Overview settings. No tracking pixel or remote images.</td></tr></table></body></html>`;
}

export class SmtpEmailProvider implements EmailProvider {
  private readonly transport;
  constructor(options: SmtpOptions) {
    this.transport = { client: nodemailer.createTransport({ host: options.host, port: options.port, secure: options.secure, requireTLS: options.requireTLS ?? (process.env.NODE_ENV === 'production' && !options.secure), tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(options.servername ? { servername: options.servername } : {}) }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000, ...(options.user && options.password ? { auth: { user: options.user, pass: options.password } } : {}) }), from: options.from, fromName: options.fromName ?? 'CodeBandage' };
  }
  async verify(): Promise<void> { await this.transport.client.verify(); }
  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    const result = await this.transport.client.sendMail({ from: { name: this.transport.fromName, address: this.transport.from }, to: message.to, subject: message.subject, text: message.text, html: message.monitoring ? renderMonitoringEmail(message.monitoring, message.text) : renderBrandedEmail(message.text), attachments: [{ filename: 'codebandage-logo.png', content: Buffer.from(emailLogoBase64, 'base64'), contentType: 'image/png', cid: 'codebandage-logo', contentDisposition: 'inline' }], ...(message.idempotencyKey ? { messageId: `<${message.idempotencyKey}@zerochack.delivery>` } : {}), disableFileAccess: true, disableUrlAccess: true });
    return { providerMessageId: result.messageId };
  }
}
