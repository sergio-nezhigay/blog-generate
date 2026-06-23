ALTER TABLE "BlogSettings" ADD COLUMN "extendedQAQuestions" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "BlogSettings" ADD COLUMN "extendedFashionCategories" JSONB NOT NULL DEFAULT '[]';
