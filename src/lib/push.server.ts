import { buildPushPayload } from "@block65/webcrypto-web-push";
import { VAPID_PUBLIC_KEY } from "./push.functions";

type Sub = { endpoint: string; p256dh: string; auth: string };

/** Envoie une notification à tous les appareils qui ne sont pas l'auteur. */
export async function notifyOthers(author: string, preview: string) {
  const privateKey = process.env["VAPID_PRIVATE_KEY"];
  if (!privateKey) return;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("push_subscriptions" as never)
    .select("endpoint, p256dh, auth")
    .neq("author", author);
  const subs = (data ?? []) as unknown as Sub[];
  const body = JSON.stringify({
    title: `Hey, ${author} t'a envoyé un message 💌`,
    body: preview.slice(0, 120),
  });
  const vapid = { subject: "mailto:contact@hibiscuspipou.lovable.app", publicKey: VAPID_PUBLIC_KEY, privateKey };
  await Promise.all(
    subs.map(async (s) => {
      try {
        const payload = await buildPushPayload(
          { data: body, options: { ttl: 3600, urgency: "high" } },
          { endpoint: s.endpoint, expirationTime: null, keys: { p256dh: s.p256dh, auth: s.auth } },
          vapid,
        );
        const res = await fetch(s.endpoint, payload);
        if (res.status === 404 || res.status === 410) {
          await supabaseAdmin.from("push_subscriptions" as never).delete().eq("endpoint", s.endpoint);
        } else if (!res.ok) {
          console.error(`Push [${res.status}]: ${await res.text()}`);
        }
      } catch (e) {
        console.error("Push error", e);
      }
    }),
  );
}
