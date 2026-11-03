-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "cached" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PayerQuestion" ADD COLUMN     "cached" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AiCache" (
    "id" TEXT NOT NULL,
    "freelancerId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "seed" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "output" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiCache_freelancerId_key_key" ON "AiCache"("freelancerId", "key");

-- AddForeignKey
ALTER TABLE "AiCache" ADD CONSTRAINT "AiCache_freelancerId_fkey" FOREIGN KEY ("freelancerId") REFERENCES "Freelancer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
