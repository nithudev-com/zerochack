import type { RequestContext } from '@zerochack/types';

export interface AuditEvent extends RequestContext {
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditWriter { write(event: AuditEvent): Promise<void>; }
