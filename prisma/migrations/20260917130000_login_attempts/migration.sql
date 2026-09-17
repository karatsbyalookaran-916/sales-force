-- Login throttling moved out of process memory. Serverless instances do not share
-- memory, so an in-process counter gave an attacker the full allowance per instance.
CREATE TABLE "login_attempts" (
    "key" VARCHAR(120) NOT NULL,
    "count" INTEGER NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "login_attempts_until_idx" ON "login_attempts"("until");
