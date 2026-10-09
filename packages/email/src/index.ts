import nodemailer from 'nodemailer';
import { emailLogoBase64 } from './brand-asset.js';

export interface EmailMessage { to: string; subject: string; text: string; idempotencyKey?: string; }
export interface EmailProvider { send(message: EmailMessage): Promise<{ providerMessageId: string }>; }

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

export class SmtpEmailProvider implements EmailProvider {
  private readonly transport;
  constructor(options: { host: string; port: number; secure: boolean; user?: string; password?: string; from: string }) {
    this.transport = { client: nodemailer.createTransport({ host: options.host, port: options.port, secure: options.secure, requireTLS: process.env.NODE_ENV === 'production' && !options.secure, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000, ...(options.user && options.password ? { auth: { user: options.user, pass: options.password } } : {}) }), from: options.from };
  }
  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    const result = await this.transport.client.sendMail({ from: { name: 'CodeBandage', address: this.transport.from }, to: message.to, subject: message.subject, text: message.text, html: renderBrandedEmail(message.text), attachments: [{ filename: 'codebandage-logo.png', content: Buffer.from(emailLogoBase64, 'base64'), contentType: 'image/png', cid: 'codebandage-logo', contentDisposition: 'inline' }], ...(message.idempotencyKey ? { messageId: `<${message.idempotencyKey}@zerochack.delivery>` } : {}), disableFileAccess: true, disableUrlAccess: true });
    return { providerMessageId: result.messageId };
  }
}
