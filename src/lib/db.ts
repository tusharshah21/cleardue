import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// One client per process; Next dev hot-reload would otherwise open a pool per reload.
const g = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  g.prisma ?? new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

if (process.env.NODE_ENV !== "production") g.prisma = db;
