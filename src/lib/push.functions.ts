import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const VAPID_PUBLIC_KEY =
  "BLlZSPuq_z_UAtA0ukW_aFHzjuNeBTZ40oH9z1YjyTlUeTqnaLUT0XInsMzclsR0Jo1T09MTIO82Qa4slqcpJ7I";

export const savePushSubscription = createServerFn({ method: "POST" })
  .inputValidator((i) =>
    z
      .object({
        author: z.string().trim().min(1).max(30),
        endpoint: z.string().url().max(1000).startsWith("https://"),
        p256dh: z.string().min(10).max(200),
        auth: z.string().min(4).max(100),
      })
      .parse(i),
  )
  .handler(async ({ data }) => {
    const { requireUnlocked } = await import("./gate.server");
    await requireUnlocked();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("push_subscriptions" as never)
      .upsert(data as never, { onConflict: "endpoint" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
