import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type Message = {
  id: string;
  author: string;
  content: string;
  youtube_id: string | null;
  gif_url: string | null;
  avatar_url: string | null;
  reactions: Record<string, string[]>;
  created_at: string;
};

export const REACTIONS = ["❤️", "😂", "🥹", "🥲"] as const;
const COLS = "id, author, content, youtube_id, gif_url, avatar_url, reactions, created_at";

export function extractYoutubeId(url: string): string | null {
  const m = url.match(
    /(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/,
  );
  return m?.[1] ?? null;
}

export const getMessages = createServerFn({ method: "GET" }).handler(
  async (): Promise<Message[]> => {
    const { requireUnlocked } = await import("./gate.server");
    await requireUnlocked();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("messages")
      .select(COLS)
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as Message[];
  },
);

export const sendMessage = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        author: z.string().trim().min(1).max(30),
        content: z.string().trim().max(2000),
        youtubeId: z.string().max(20).nullable().optional(),
        gifUrl: z.string().url().max(1000).refine((u) => /^https:\/\/([a-z0-9-]+\.)*klipy\.com\//.test(u)).nullable().optional(),
        avatarUrl: z.string().max(60000).refine((u) => u.startsWith("data:image/")).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Message> => {
    if (!data.content && !data.gifUrl) throw new Error("Message vide");
    const { requireUnlocked } = await import("./gate.server");
    await requireUnlocked();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("messages")
      .insert({
        author: data.author,
        content: data.content,
        youtube_id: data.youtubeId ?? null,
        gif_url: data.gifUrl ?? null,
        avatar_url: data.avatarUrl ?? null,
      } as never)
      .select(COLS)
      .single();
    if (error) throw new Error(error.message);
    try {
      const { notifyOthers } = await import("./push.server");
      await notifyOthers(data.author, data.gifUrl && !data.content ? "👁️‍🗨️ GIF" : data.content);
    } catch (e) {
      console.error(e);
    }
    return row as unknown as Message;
  });

export const deleteMessage = createServerFn({ method: "POST" })
  .inputValidator((i) => z.object({ id: z.string().uuid(), author: z.string().min(1).max(30) }).parse(i))
  .handler(async ({ data }) => {
    const { requireUnlocked } = await import("./gate.server");
    await requireUnlocked();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("messages").delete().eq("id", data.id).eq("author", data.author);
    if (error) throw new Error(error.message);
    return { id: data.id };
  });

export const toggleReaction = createServerFn({ method: "POST" })
  .inputValidator((i) =>
    z.object({ id: z.string().uuid(), author: z.string().min(1).max(30), emoji: z.enum(REACTIONS) }).parse(i),
  )
  .handler(async ({ data }): Promise<Message> => {
    const { requireUnlocked } = await import("./gate.server");
    await requireUnlocked();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin.from("messages").select("reactions").eq("id", data.id).single();
    if (error) throw new Error(error.message);
    const r = { ...((row.reactions as Record<string, string[]>) ?? {}) };
    const list = r[data.emoji] ?? [];
    r[data.emoji] = list.includes(data.author) ? list.filter((a) => a !== data.author) : [...list, data.author];
    if (!r[data.emoji]?.length) delete r[data.emoji];
    const { data: updated, error: e2 } = await supabaseAdmin
      .from("messages").update({ reactions: r }).eq("id", data.id).select(COLS).single();
    if (e2) throw new Error(e2.message);
    return updated as unknown as Message;
  });

export type Gif = { id: string; preview: string; url: string; title: string };

export const searchGifs = createServerFn({ method: "GET" })
  .inputValidator((i) => z.object({ q: z.string().max(100) }).parse(i))
  .handler(async ({ data }): Promise<Gif[]> => {
    const { requireUnlocked } = await import("./gate.server");
    await requireUnlocked();
    const LOVABLE_API_KEY = process.env["LOVABLE_API_KEY"];
    const KLIPY_API_KEY = process.env["KLIPY_API_KEY"];
    if (!LOVABLE_API_KEY || !KLIPY_API_KEY) throw new Error("GIF non configurés");
    const params = new URLSearchParams({ customer_id: "notre-espace", per_page: "24" });
    const q = data.q.trim();
    if (q) params.set("q", q);
    const res = await fetch(
      `https://connector-gateway.lovable.dev/klipy/gifs/${q ? "search" : "trending"}?${params}`,
      { headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "X-Connection-Api-Key": KLIPY_API_KEY } },
    );
    if (!res.ok) throw new Error(`GIF [${res.status}]: ${await res.text()}`);
    const json = await res.json();
    if (!json.result) throw new Error("GIF indisponibles");
    type F = { gif?: { url: string }; webp?: { url: string } };
    const pick = (f: Record<string, F> | undefined, sizes: string[]) => {
      for (const s of sizes) { const v = f?.[s]; if (v?.gif?.url) return v.gif.url; if (v?.webp?.url) return v.webp.url; }
      return null;
    };
    return (json.data?.data ?? [])
      .map((it: { id: number; title?: string; file?: Record<string, F> }) => {
        const url = pick(it.file, ["md", "sm", "hd", "xs"]);
        const preview = pick(it.file, ["sm", "xs", "md"]) ?? url;
        return url ? { id: String(it.id), url, preview, title: it.title ?? "" } : null;
      })
      .filter(Boolean) as Gif[];
  });
