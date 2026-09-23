export type EntityId = string;
export type TenantId = EntityId;
export type UserId = EntityId;

export interface RequestContext {
  requestId: string;
  userId?: UserId;
  tenantId?: TenantId;
}

export interface ApiErrorResponse {
  error: { code: string; message: string; requestId: string; details?: unknown };
}
