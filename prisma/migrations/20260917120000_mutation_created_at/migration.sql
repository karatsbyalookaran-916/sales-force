-- Mutation receipts had no timestamp, so nothing could be pruned by age.
-- Existing rows adopt the migration time; they are retried-request guards only.
ALTER TABLE "mutations" ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "mutations_created_at_idx" ON "mutations"("created_at");
