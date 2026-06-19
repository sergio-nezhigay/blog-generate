-- CreateTable
CREATE TABLE "BlogContentPlan" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "dayIndex" INTEGER NOT NULL,
    "scheduledDate" DATE NOT NULL,
    "topic" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "contentFormat" TEXT NOT NULL,
    "targetWordCount" INTEGER NOT NULL DEFAULT 2000,
    "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'planned',
    "articleId" TEXT,
    "articleUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlogContentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlogSettings" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "blogId" TEXT NOT NULL DEFAULT '',
    "blogTitle" TEXT NOT NULL DEFAULT '',
    "brandName" TEXT NOT NULL DEFAULT 'ENCANTO',
    "ctaUrl" TEXT NOT NULL DEFAULT '/pages/contact',
    "servicesUrl" TEXT NOT NULL DEFAULT '/pages/collections/all',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlogSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BlogContentPlan_shop_scheduledDate_status_idx" ON "BlogContentPlan"("shop", "scheduledDate", "status");

-- CreateIndex
CREATE INDEX "BlogContentPlan_shop_weekStart_idx" ON "BlogContentPlan"("shop", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "BlogSettings_shop_key" ON "BlogSettings"("shop");
