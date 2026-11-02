-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "replayed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PayerQuestion" ADD COLUMN     "replayed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "wantsPlan" BOOLEAN NOT NULL DEFAULT false;
