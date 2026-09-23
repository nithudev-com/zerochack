ALTER TABLE "ai_models" ALTER COLUMN "max_output_tokens" SET DEFAULT 4096;

-- Earlier defaults are too small for reasoning-model output because the limit
-- includes both hidden reasoning and visible response tokens.
UPDATE "ai_models"
SET "max_output_tokens" = 4096,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "max_output_tokens" < 4096;
