CREATE TABLE "support_conversations" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "customer_user_id" UUID NOT NULL,
  "assigned_specialist_id" UUID,
  "subject" VARCHAR(240) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'OPEN',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at" TIMESTAMPTZ(6),
  CONSTRAINT "support_conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "support_conversations_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "support_conversations_assigned_specialist_id_fkey" FOREIGN KEY ("assigned_specialist_id") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "support_conversations_status_check" CHECK ("status" IN ('OPEN','ASSIGNED','CLOSED'))
);
CREATE INDEX "support_conversations_tenant_customer_updated_idx" ON "support_conversations"("tenant_id","customer_user_id","updated_at");
CREATE INDEX "support_conversations_status_specialist_updated_idx" ON "support_conversations"("status","assigned_specialist_id","updated_at");

CREATE TABLE "support_messages" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id" UUID NOT NULL,
  "author_user_id" UUID,
  "type" VARCHAR(20) NOT NULL,
  "content" VARCHAR(4000) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "support_conversations"("id") ON DELETE CASCADE,
  CONSTRAINT "support_messages_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "support_messages_type_check" CHECK ("type" IN ('CUSTOMER','AI','SPECIALIST','SYSTEM'))
);
CREATE INDEX "support_messages_conversation_created_idx" ON "support_messages"("conversation_id","created_at");
