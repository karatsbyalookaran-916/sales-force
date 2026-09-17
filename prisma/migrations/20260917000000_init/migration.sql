-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'member');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(200) NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "admin_lock" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "user_id" UUID NOT NULL,
    CONSTRAINT "admin_lock_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_lock_singleton" CHECK ("id" = 1)
);

CREATE TABLE "sessions" (
    "token" CHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sessions_pkey" PRIMARY KEY ("token")
);

CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "data" JSONB NOT NULL,
    "version" INTEGER NOT NULL,
    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mutations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "result" JSONB NOT NULL,
    CONSTRAINT "mutations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "activity" (
    "id" BIGSERIAL NOT NULL,
    "lead_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "activity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "admin_lock_user_id_key" ON "admin_lock"("user_id");
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");
CREATE INDEX "activity_lead_id_id_idx" ON "activity"("lead_id", "id" DESC);

ALTER TABLE "admin_lock" ADD CONSTRAINT "admin_lock_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mutations" ADD CONSTRAINT "mutations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "activity" ADD CONSTRAINT "activity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
