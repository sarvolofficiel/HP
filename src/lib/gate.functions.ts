import { createServerFn } from "@tanstack/react-start";

export const unlockSite = createServerFn({ method: "POST" })
  .inputValidator((data: { password: string }) => data)
  .handler(async ({ data }) => {
    const { passwordMatches, markUnlocked } = await import("./gate.server");
    const expected = process.env["SITE_PASSWORD"];
    if (!expected) throw new Error("SITE_PASSWORD is not set");
    if (!passwordMatches(data.password, expected)) {
      return { ok: false as const };
    }
    await markUnlocked();
    return { ok: true as const };
  });

export const lockSite = createServerFn({ method: "POST" }).handler(async () => {
  const { clearSession } = await import("./gate.server");
  await clearSession();
  return { ok: true as const };
});
