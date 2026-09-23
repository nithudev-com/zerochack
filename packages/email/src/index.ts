import nodemailer from 'nodemailer';

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

export class SmtpEmailProvider implements EmailProvider {
  private readonly transport;
  constructor(options: { host: string; port: number; secure: boolean; user?: string; password?: string; from: string }) {
    this.transport = { client: nodemailer.createTransport({ host: options.host, port: options.port, secure: options.secure, ...(options.user && options.password ? { auth: { user: options.user, pass: options.password } } : {}) }), from: options.from };
  }
  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    const result = await this.transport.client.sendMail({ from: this.transport.from, to: message.to, subject: message.subject, text: message.text, ...(message.idempotencyKey ? { messageId: `<${message.idempotencyKey}@zerochack.delivery>` } : {}), disableFileAccess: true, disableUrlAccess: true });
    return { providerMessageId: result.messageId };
  }
}
