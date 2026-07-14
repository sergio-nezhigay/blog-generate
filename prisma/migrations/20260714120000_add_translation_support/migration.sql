-- AlterTable
ALTER TABLE "BlogSettings" ADD COLUMN     "translationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "translationLocales" TEXT[] NOT NULL DEFAULT ARRAY['ar','cs','da','de','el','es','fi','fr','hu','it','nl','no','pl','ro','ru','sk','sv','tr','uk']::TEXT[];

-- CreateTable
CREATE TABLE "ArticleTranslation" (
    "id" SERIAL NOT NULL,
    "planId" INTEGER NOT NULL,
    "shop" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "translatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArticleTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArticleTranslation_planId_locale_key" ON "ArticleTranslation"("planId", "locale");

-- CreateIndex
CREATE INDEX "ArticleTranslation_shop_status_idx" ON "ArticleTranslation"("shop", "status");
