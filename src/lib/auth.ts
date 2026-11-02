// Single demo freelancer login (hackathon scope): env credentials, iron-session cookie.
import { createHash, timingSafeEqual } from "node:crypto";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "./db";

interface SessionData {
  freelancerId?: string;
}

async function session() {
  const password = process.env.SESSION_PASSWORD;
  if (!password || password.length < 32) throw new Error("SESSION_PASSWORD must be set (32+ characters)");
  return getIronSession<SessionData>(await cookies(), {
    password,
    cookieName: "cleardue_session",
    cookieOptions: { secure: process.env.NODE_ENV === "production", sameSite: "lax", httpOnly: true },
  });
}

const sameSecret = (a: string, b: string) =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export async function logIn(email: string, password: string): Promise<boolean> {
  const demoEmail = process.env.DEMO_EMAIL ?? "";
  const demoPassword = process.env.DEMO_PASSWORD ?? "";
  if (!demoEmail || !demoPassword) return false;
  if (!(sameSecret(email.trim().toLowerCase(), demoEmail.toLowerCase()) && sameSecret(password, demoPassword))) return false;
  const freelancer = await db.freelancer.findUnique({ where: { email: demoEmail.toLowerCase() } });
  if (!freelancer) return false;
  const s = await session();
  s.freelancerId = freelancer.id;
  await s.save();
  return true;
}

export async function logOut() {
  (await session()).destroy();
}

/** For pages and actions: the signed-in freelancer, or a redirect to /login. */
export async function requireFreelancer() {
  const { freelancerId } = await session();
  const freelancer = freelancerId ? await db.freelancer.findUnique({ where: { id: freelancerId } }) : null;
  if (!freelancer) redirect("/login");
  return freelancer;
}
