import { useSession } from "@tanstack/react-start/server";
import { redirect } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "node:crypto";

const sessionConfig = {
  password: process.env["SESSION_SECRET"]!,
  name: "espace-couple",
  maxAge: 60 * 60 * 24 * 30,
  cookie: { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/" },
};

export type GateSession = { unlocked?: boolean };

export function passwordMatches(input: string, expected: string): boolean {
  const a = createHash("sha256").update(input, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export async function requireUnlocked() {
  const session = await useSession<GateSession>(sessionConfig);
  if (!session.data.unlocked) throw redirect({ to: "/unlock" });
  return session;
}

export async function markUnlocked() {
  const session = await useSession<GateSession>(sessionConfig);
  await session.update({ unlocked: true });
}

export async function clearSession() {
  const session = await useSession<GateSession>(sessionConfig);
  await session.clear();
}
