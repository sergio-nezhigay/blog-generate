-- Add generatingStartedAt for tracking in-progress article generation
ALTER TABLE "BlogContentPlan" ADD COLUMN "generatingStartedAt" TIMESTAMP(3);
