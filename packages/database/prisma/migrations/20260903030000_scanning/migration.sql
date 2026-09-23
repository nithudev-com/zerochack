ALTER TYPE "FindingStatus" RENAME VALUE 'ACCEPTED' TO 'ACCEPTED_RISK';
ALTER TYPE "FindingStatus" ADD VALUE 'ACKNOWLEDGED';
ALTER TYPE "FindingStatus" ADD VALUE 'IN_REMEDIATION';
ALTER TYPE "FindingStatus" ADD VALUE 'FALSE_POSITIVE';
ALTER TYPE "FindingStatus" ADD VALUE 'REOPENED';
CREATE TYPE "VerificationMethod" AS ENUM ('DNS', 'HTTP', 'CONNECTOR');

ALTER TABLE "websites" ADD COLUMN "connected_at" TIMESTAMPTZ(6), ADD COLUMN "connection_error_code" VARCHAR(120);
ALTER TABLE "website_verifications" ADD COLUMN "method" "VerificationMethod" NOT NULL DEFAULT 'DNS';
ALTER TABLE "website_verifications" ALTER COLUMN "method" DROP DEFAULT;

ALTER TABLE "scans"
  ADD COLUMN "progress" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "engine_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "completed_engines" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "final_url" VARCHAR(2048),
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "scans" ADD CONSTRAINT "scans_progress_range" CHECK ("progress" BETWEEN 0 AND 100);
WITH ranked AS (
  SELECT "id", row_number() OVER (PARTITION BY "tenant_id", "website_id" ORDER BY "requested_at" DESC, "id") AS position
  FROM "scans" WHERE "status" IN ('QUEUED', 'RUNNING')
)
UPDATE "scans" SET "status" = 'CANCELLED', "error_code" = 'SUPERSEDED_DURING_MIGRATION', "completed_at" = CURRENT_TIMESTAMP
FROM ranked WHERE "scans"."id" = ranked."id" AND ranked.position > 1;
CREATE UNIQUE INDEX "scans_one_active_per_website" ON "scans"("tenant_id", "website_id") WHERE "status" IN ('QUEUED', 'RUNNING');
CREATE UNIQUE INDEX "scans_tenant_website_id_key" ON "scans"("tenant_id", "website_id", "id");

ALTER TABLE "security_findings"
  ADD COLUMN "scan_id" UUID,
  ADD COLUMN "fingerprint" CHAR(64),
  ADD COLUMN "confidence" DECIMAL(4,3),
  ADD COLUMN "affected_resource" VARCHAR(2048),
  ADD COLUMN "recommendation" TEXT,
  ADD COLUMN "cwe" VARCHAR(32),
  ADD COLUMN "cve" VARCHAR(32),
  ADD COLUMN "owasp_category" VARCHAR(64),
  ADD COLUMN "remediation_supported" BOOLEAN NOT NULL DEFAULT false;

INSERT INTO "scans" ("id", "tenant_id", "website_id", "status", "requested_at", "completed_at", "progress")
SELECT gen_random_uuid(), f."tenant_id", f."website_id", 'SUCCEEDED', MIN(f."created_at"), MAX(f."created_at"), 100
FROM "security_findings" f WHERE f."scan_id" IS NULL GROUP BY f."tenant_id", f."website_id";
UPDATE "security_findings" f SET "scan_id" = s."id" FROM "scans" s
WHERE f."scan_id" IS NULL AND s."tenant_id" = f."tenant_id" AND s."website_id" = f."website_id" AND s."status" = 'SUCCEEDED';
UPDATE "security_findings" f SET
  "fingerprint" = md5(f."id"::text) || md5(f."title"), "confidence" = 0.500,
  "affected_resource" = w."url", "recommendation" = 'Review this migrated finding and record a recommendation.'
FROM "websites" w WHERE w."id" = f."website_id";
ALTER TABLE "security_findings" ALTER COLUMN "scan_id" SET NOT NULL, ALTER COLUMN "fingerprint" SET NOT NULL,
  ALTER COLUMN "confidence" SET NOT NULL, ALTER COLUMN "affected_resource" SET NOT NULL, ALTER COLUMN "recommendation" SET NOT NULL;
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "scans"("id") ON DELETE CASCADE;
CREATE UNIQUE INDEX "security_findings_scan_id_fingerprint_key" ON "security_findings"("scan_id", "fingerprint");
CREATE UNIQUE INDEX "security_findings_tenant_website_scan_id_key" ON "security_findings"("tenant_id", "website_id", "scan_id", "id");
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_tenant_website_scan_fkey" FOREIGN KEY ("tenant_id", "website_id", "scan_id") REFERENCES "scans"("tenant_id", "website_id", "id") ON DELETE CASCADE;

CREATE TABLE "finding_evidence" (
  "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL, "scan_id" UUID NOT NULL, "finding_id" UUID NOT NULL,
  "engine" VARCHAR(120) NOT NULL, "engine_version" VARCHAR(40) NOT NULL, "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "summary" TEXT NOT NULL, "metadata" JSONB NOT NULL, "integrity_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "finding_evidence_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE,
  CONSTRAINT "finding_evidence_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "scans"("id") ON DELETE CASCADE,
  CONSTRAINT "finding_evidence_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "security_findings"("id") ON DELETE CASCADE,
  CONSTRAINT "finding_evidence_tenant_website_fkey" FOREIGN KEY ("tenant_id", "website_id") REFERENCES "websites"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "finding_evidence_tenant_website_scan_fkey" FOREIGN KEY ("tenant_id", "website_id", "scan_id") REFERENCES "scans"("tenant_id", "website_id", "id") ON DELETE CASCADE,
  CONSTRAINT "finding_evidence_tenant_scan_finding_fkey" FOREIGN KEY ("tenant_id", "website_id", "scan_id", "finding_id") REFERENCES "security_findings"("tenant_id", "website_id", "scan_id", "id") ON DELETE CASCADE,
  CONSTRAINT "finding_evidence_integrity_format" CHECK ("integrity_hash" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "finding_evidence_tenant_id_website_id_scan_id_idx" ON "finding_evidence"("tenant_id", "website_id", "scan_id");
CREATE INDEX "finding_evidence_finding_id_idx" ON "finding_evidence"("finding_id");

INSERT INTO "permissions" ("id", "key", "description", "created_at") VALUES
('20000000-0000-4000-8000-00000000002a', 'findings.manage', 'Change finding lifecycle in an authorized tenant', CURRENT_TIMESTAMP);
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON p."key" = 'findings.manage'
WHERE r."name" IN ('Customer', 'Cybersecurity Specialist', 'Owner');
