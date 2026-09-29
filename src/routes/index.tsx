import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  getMessages,
  sendMessage,
  deleteMessage,
  toggleReaction,
  searchGifs,
  REACTIONS,
  extractYoutubeId,
  type Gif,
  type Message,
} from "@/lib/chat.functions";
import { lockSite } from "@/lib/gate.functions";
import { CallRoom } from "@/components/CallRoom";
import { savePushSubscription, VAPID_PUBLIC_KEY } from "@/lib/push.functions";
import notifSound from "@/assets/notif.mp3.asset.json";

export const Route = createFileRoute("/")({
  loader: () => getMessages(),
  head: () => ({
    meta: [
      { title: "P&H — Messages, appels et vidéos" },
      { name: "description", content: "Notre messagerie privée : messages, appels vidéo et vidéos YouTube partagées." },
      { property: "og:title", content: "P&H — Messages, appels et vidéos" },
      { property: "og:description", content: "Notre messagerie privée : messages, appels vidéo et vidéos YouTube partagées." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Home,
});

type Tab = "messages" | "appel" | "videos" | "parametres";

// Réduit la photo à 128px pour qu'elle reste légère
function resizeAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const size = 128;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("canvas"));
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => reject(new Error("image illisible"));
    img.src = URL.createObjectURL(file);
  });
}

function Home() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const initialMessages = Route.useLoaderData();
  const [tab, setTab] = useState<Tab>("messages");
  const [name, setName] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [avatarInput, setAvatarInput] = useState<string | null>(null);
  const [typing, setTyping] = useState<Record<string, { ts: number; avatar: string | null }>>({});
  const [showTuto, setShowTuto] = useState(false);
  const lock = useServerFn(lockSite);

  useEffect(() => {
    const stored = localStorage.getItem("espace-couple-name");
    if (stored) setName(stored);
    const storedAvatar = localStorage.getItem("espace-couple-avatar");
    if (storedAvatar) setAvatar(storedAvatar);
  }, []);

  function closeTuto() {
    localStorage.setItem("espace-couple-tuto", "done");
    setShowTuto(false);
  }

  const { data: messages } = useQuery({
    queryKey: ["messages"],
    queryFn: () => getMessages(),
    initialData: initialMessages,
  });

  // Messages en direct : le message arrive instantanément chez l'autre
  useEffect(() => {
    const channel = supabase
      .channel("couple-chat")
      .on("broadcast", { event: "new_message" }, ({ payload }) => {
        const message = payload?.message as Message | undefined;
        if (message && message.author !== localStorage.getItem("espace-couple-name")) {
          new Audio(notifSound.url).play().catch(() => {});
        }
        queryClient.setQueryData<Message[]>(["messages"], (old) => {
          const list = old ?? [];
          if (!message || list.some((m) => m.id === message.id)) return list;
          return [...list, message];
        });
      })
      .on("broadcast", { event: "update_message" }, ({ payload }) => {
        const message = payload?.message as Message | undefined;
        if (!message) return;
        queryClient.setQueryData<Message[]>(["messages"], (old) =>
          (old ?? []).map((m) => (m.id === message.id ? message : m)),
        );
      })
      .on("broadcast", { event: "delete_message" }, ({ payload }) => {
        const id = payload?.id as string | undefined;
        queryClient.setQueryData<Message[]>(["messages"], (old) => (old ?? []).filter((m) => m.id !== id));
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  // Indicateur "en train d'écrire…" : reçoit les frappes de l'autre
  useEffect(() => {
    const ch = supabase
      .channel("couple-chat-typing")
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        const author = payload?.author as string | undefined;
        if (!author) return;
        setTyping((t) => ({ ...t, [author]: { ts: Date.now(), avatar: (payload?.avatar as string | null) ?? null } }));
      })
      .subscribe();
    const timer = setInterval(() => {
      setTyping((t) => {
        const now = Date.now();
        const entries = Object.entries(t).filter(([, v]) => now - v.ts < 3000);
        return entries.length === Object.keys(t).length ? t : Object.fromEntries(entries);
      });
    }, 1000);
    return () => {
      supabase.removeChannel(ch);
      clearInterval(timer);
    };
  }, []);

  async function handleLock() {
    await lock();
    await router.navigate({ to: "/unlock" });
  }

  if (!name) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="card-warm animate-fade-up w-full max-w-sm p-8 text-center">
          <h1 className="text-2xl font-semibold">Bienvenue 🍁</h1>
          <p className="mt-2 text-sm text-muted-foreground">Comment dois-je t'appeler ?</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const n = nameInput.trim();
              if (!n) return;
              localStorage.setItem("espace-couple-name", n);
              if (avatarInput) localStorage.setItem("espace-couple-avatar", avatarInput);
              setAvatar(avatarInput);
              setName(n);
              if (!localStorage.getItem("espace-couple-tuto")) setShowTuto(true);
            }}
          >
            <label className="mt-5 block cursor-pointer">
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setAvatarInput(await resizeAvatar(file));
                }}
              />
              {avatarInput ? (
                <img
                  src={avatarInput}
                  alt="Ta photo de profil"
                  className="mx-auto h-24 w-24 rounded-full border-2 border-primary object-cover"
                />
              ) : (
                <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full border-2 border-dashed border-primary/50 bg-accent text-3xl">
                  📷
                </div>
              )}
              <span className="mt-2 block text-xs font-semibold text-primary">
                {avatarInput ? "Changer la photo" : "Choisis ta photo de profil"}
              </span>
            </label>
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              maxLength={30}
              autoFocus
              placeholder="Ton prénom"
              className="input-warm mt-4 w-full px-4 py-3 text-center"
            />
            <button type="submit" className="btn-autumn mt-4 w-full px-4 py-3 font-semibold">
              C'est moi
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-card/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-3 py-3 sm:px-4">
          <h1 className="shrink-0 text-lg font-semibold">P&H 🍂</h1>
          <nav className="flex min-w-0 items-center gap-1">
            {(
              [
                ["messages", "💬", "Messages"],
                ["appel", "📞", "Appel"],
                ["videos", "🎬", "Vidéos"],
                ["parametres", "⚙️", "Paramètres"],
              ] as [Tab, string, string][]
            ).map(([key, emoji, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                title={label}
                className={`shrink-0 rounded-full px-2.5 py-1.5 text-sm font-semibold transition-colors sm:px-3 ${
                  tab === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
                }`}
              >
                {emoji}
                <span className="hidden sm:inline"> {label}</span>
              </button>
            ))}
            <button
              onClick={handleLock}
              title="Verrouiller"
              className="ml-1 rounded-full px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent"
            >
              🔒
            </button>
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pb-6">
        {tab === "messages" && (
          <ChatTab
            messages={messages ?? []}
            name={name}
            avatar={avatar}
            typing={Object.entries(typing)
              .filter(([a]) => a !== name)
              .map(([a, v]) => ({ author: a, avatar: v.avatar }))}
          />
        )}
        {tab === "appel" && <CallRoom name={name} avatar={avatar} />}
        {tab === "videos" && <VideosTab messages={messages ?? []} />}
        {tab === "parametres" && (
          <SettingsTab
            name={name}
            avatar={avatar}
            onShowTuto={() => setShowTuto(true)}
            onSave={(n, a) => {
              localStorage.setItem("espace-couple-name", n);
              if (a) localStorage.setItem("espace-couple-avatar", a);
              else localStorage.removeItem("espace-couple-avatar");
              setName(n);
              setAvatar(a);
            }}
          />
        )}
      </main>
      {showTuto && <Tutorial onClose={closeTuto} />}
      {!showTuto && <NotifPrompt name={name} />}
    </div>
  );
}

const TUTO_STEPS = [
  {
    emoji: "💬",
    title: "Les messages",
    text: "Écris en bas et appuie sur Envoyer. Touche un message pour réagir avec ❤️ 😂 🥹 🥲, ou pour supprimer un de tes messages. Quand l'autre écrit, une petite bulle avec des points apparaît.",
  },
  {
    emoji: "👁️‍🗨️",
    title: "Les GIFs",
    text: "Le bouton œil ouvre le choix de GIFs : cherche un mot (amour, bisou, rire…) et touche celui qui te plaît pour l'envoyer.",
  },
  {
    emoji: "🎬",
    title: "Les vidéos YouTube",
    text: "Le bouton 🎬 permet de coller un lien YouTube avec ton message. Toutes vos vidéos se retrouvent ensuite dans l'onglet Vidéos.",
  },
  {
    emoji: "📞",
    title: "Les appels",
    text: "Dans l'onglet Appel, appuie sur « Rejoindre l'appel » : dès que vous êtes deux, l'appel vidéo démarre tout seul. Tu peux couper le micro, la caméra, et l'anti-bruit enlève les bruits de fond.",
  },
  {
    emoji: "⚙️",
    title: "Les paramètres",
    text: "Change ton prénom ou ta photo de profil quand tu veux. Le bouton 🔒 en haut verrouille le site : il faudra le mot de passe pour revenir.",
  },
];

function Tutorial({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const last = step === TUTO_STEPS.length - 1;
  const s = TUTO_STEPS[step]!;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 px-4 backdrop-blur-sm">
      <div className="card-warm animate-fade-up w-full max-w-sm p-6 text-center sm:p-8">
        <p className="text-5xl">{s.emoji}</p>
        <h2 className="mt-3 text-xl font-semibold">{s.title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.text}</p>
        <div className="mt-5 flex justify-center gap-1.5">
          {TUTO_STEPS.map((_, i) => (
            <span
              key={i}
              className={`h-2 rounded-full transition-all ${i === step ? "w-5 bg-primary" : "w-2 bg-border"}`}
            />
          ))}
        </div>
        <div className="mt-5 flex items-center justify-between gap-2">
          <button onClick={onClose} className="px-3 py-2 text-sm text-muted-foreground hover:underline">
            Passer
          </button>
          <button
            onClick={() => (last ? onClose() : setStep(step + 1))}
            className="btn-autumn px-5 py-2.5 text-sm font-semibold"
          >
            {last ? "C'est parti 🍂" : "Suivant"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Avatar({ src, name }: { src: string | null; name: string }) {
  if (src) {
    return <img src={src} alt={name} className="h-9 w-9 shrink-0 rounded-full border border-border object-cover" />;
  }
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-primary">
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function YoutubeEmbed({ id }: { id: string }) {
  return (
    <div className="mt-2 overflow-hidden rounded-xl">
      <iframe
        src={`https://www.youtube.com/embed/${id}`}
        title="Vidéo YouTube"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        className="aspect-video w-full"
      />
    </div>
  );
}

function ChatTab({
  messages,
  name,
  avatar,
  typing,
}: {
  messages: Message[];
  name: string;
  avatar: string | null;
  typing: { author: string; avatar: string | null }[];
}) {
  const queryClient = useQueryClient();
  const send = useServerFn(sendMessage);
  const [text, setText] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [showVideo, setShowVideo] = useState(false);
  const [sending, setSending] = useState(false);
  const [showGifs, setShowGifs] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const del = useServerFn(deleteMessage);
  const react = useServerFn(toggleReaction);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastTypingSent = useRef(0);

  // Prévient l'autre qu'on est en train d'écrire (au max toutes les 1,5 s)
  function notifyTyping() {
    const now = Date.now();
    if (now - lastTypingSent.current < 1500) return;
    lastTypingSent.current = now;
    supabase.channel("couple-chat-typing").send({
      type: "broadcast",
      event: "typing",
      payload: { author: name, avatar },
    });
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  function broadcast(event: string, payload: object) {
    supabase.channel("couple-chat").send({ type: "broadcast", event, payload });
  }

  async function onDelete(id: string) {
    setMenuFor(null);
    await del({ data: { id, author: name } });
    queryClient.setQueryData<Message[]>(["messages"], (old) => (old ?? []).filter((m) => m.id !== id));
    broadcast("delete_message", { id });
  }

  async function onReact(id: string, emoji: (typeof REACTIONS)[number]) {
    setMenuFor(null);
    const message = await react({ data: { id, author: name, emoji } });
    queryClient.setQueryData<Message[]>(["messages"], (old) => (old ?? []).map((m) => (m.id === id ? message : m)));
    broadcast("update_message", { message });
  }

  async function sendGif(gif: Gif) {
    setShowGifs(false);
    const message = await send({ data: { author: name, content: "", gifUrl: gif.url, avatarUrl: avatar } });
    broadcast("new_message", { message });
    queryClient.setQueryData<Message[]>(["messages"], (old) => {
      const list = old ?? [];
      return list.some((m) => m.id === message.id) ? list : [...list, message];
    });
  }

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    const youtubeId = videoUrl.trim() ? extractYoutubeId(videoUrl.trim()) : null;
    const message = await send({ data: { author: name, content, youtubeId, avatarUrl: avatar } });
    supabase.channel("couple-chat").send({
      type: "broadcast",
      event: "new_message",
      payload: { message },
    });
    setText("");
    setVideoUrl("");
    setShowVideo(false);
    setSending(false);
    queryClient.setQueryData<Message[]>(["messages"], (old) => {
      const list = old ?? [];
      if (list.some((m) => m.id === message.id)) return list;
      return [...list, message];
    });
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 space-y-3 py-6">
        {messages.length === 0 && (
          <p className="py-16 text-center text-sm text-muted-foreground">
            Aucun message pour l'instant… écris le premier 💌
          </p>
        )}
        {messages.map((m) => {
          const mine = m.author === name;
          return (
            <div key={m.id} className={`animate-fade-up relative flex items-end gap-2 ${menuFor === m.id ? "z-20" : ""} ${mine ? "justify-end" : "justify-start"}`}>
              {!mine && <Avatar src={m.avatar_url} name={m.author} />}
              <div className="group relative max-w-[80%]">
                <div
                  onClick={() => setMenuFor(menuFor === m.id ? null : m.id)}
                  className={`cursor-pointer px-4 py-2.5 ${mine ? "bubble-me" : "bubble-other"}`}
                >
                  <p className={`text-[11px] font-bold uppercase tracking-wide ${mine ? "opacity-70" : "text-primary"}`}>
                    {m.author}
                  </p>
                  {m.content && (
                    <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{m.content}</p>
                  )}
                  {m.gif_url && (
                    <img src={m.gif_url} alt="GIF" loading="lazy" className="mt-1 max-h-60 rounded-xl" />
                  )}
                  {m.youtube_id && <YoutubeEmbed id={m.youtube_id} />}
                  <p className={`mt-1 text-right text-[10px] ${mine ? "opacity-60" : "text-muted-foreground"}`}>
                    {new Date(m.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
                {Object.keys(m.reactions ?? {}).length > 0 && (
                  <div className={`-mt-2 flex gap-1 ${mine ? "justify-end" : "justify-start"} px-2`}>
                    {Object.entries(m.reactions).map(([emo, who]) => (
                      <button
                        key={emo}
                        onClick={() => onReact(m.id, emo as (typeof REACTIONS)[number])}
                        title={who.join(", ")}
                        className={`card-warm px-1.5 py-0.5 text-xs ${who.includes(name) ? "ring-1 ring-primary" : ""}`}
                      >
                        {emo}
                        {who.length > 1 && <span className="ml-0.5">{who.length}</span>}
                      </button>
                    ))}
                  </div>
                )}
                {menuFor === m.id && (
                  <div className={`card-warm absolute z-10 mt-1 flex items-center gap-1 p-1 ${mine ? "right-0" : "left-0"}`}>
                    {REACTIONS.map((emo) => (
                      <button
                        key={emo}
                        aria-label={`Réagir ${emo}`}
                        onClick={() => onReact(m.id, emo)}
                        className="rounded-lg px-1.5 py-1 text-xl transition-transform hover:scale-125"
                      >
                        {emo}
                      </button>
                    ))}
                    {mine && (
                      <button
                        onClick={() => onDelete(m.id)}
                        className="ml-1 rounded-lg px-2 py-1 text-sm text-destructive hover:bg-accent"
                      >
                        🗑️ Supprimer
                      </button>
                    )}
                  </div>
                )}
              </div>
              {mine && <Avatar src={m.avatar_url} name={m.author} />}
            </div>
          );
        })}
        {typing.map((t) => (
          <div key={t.author} className="animate-fade-up flex items-end gap-2">
            <Avatar src={t.avatar} name={t.author} />
            <div className="bubble-other px-4 py-3">
              <span className="typing-dots" aria-label={`${t.author} est en train d'écrire`}>
                <span />
                <span />
                <span />
              </span>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={onSend} className="card-warm sticky bottom-4 mt-2 p-3">
        {showGifs && <GifPicker onPick={sendGif} />}
        {showVideo && (
          <input
            value={videoUrl}
            onChange={(e) => setVideoUrl(e.target.value)}
            placeholder="Colle un lien YouTube ici…"
            className="input-warm mb-2 w-full px-3 py-2 text-sm"
          />
        )}
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => setShowVideo((v) => !v)}
            title="Partager une vidéo YouTube"
            className={`rounded-xl px-3 py-2.5 text-lg transition-colors ${showVideo ? "bg-accent" : "hover:bg-accent"}`}
          >
            🎬
          </button>
          <button
            type="button"
            onClick={() => setShowGifs((v) => !v)}
            title="Envoyer un GIF"
            className={`rounded-xl px-3 py-2.5 text-lg transition-colors ${showGifs ? "bg-accent" : "hover:bg-accent"}`}
          >
            👁️‍🗨️
          </button>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (e.target.value.trim()) notifyTyping();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend(e);
              }
            }}
            rows={1}
            placeholder="Écris quelque chose de doux…"
            className="input-warm flex-1 resize-none px-4 py-2.5 text-[15px]"
          />
          <button type="submit" disabled={sending || !text.trim()} className="btn-autumn px-4 py-2.5 font-semibold">
            Envoyer
          </button>
        </div>
      </form>
    </div>
  );
}

function SettingsTab({
  name,
  avatar,
  onSave,
  onShowTuto,
}: {
  name: string;
  avatar: string | null;
  onSave: (name: string, avatar: string | null) => void;
  onShowTuto: () => void;
}) {
  const [nameInput, setNameInput] = useState(name);
  const [avatarInput, setAvatarInput] = useState<string | null>(avatar);
  const [saved, setSaved] = useState(false);

  return (
    <div className="py-6">
      <h2 className="text-xl font-semibold">Paramètres ⚙️</h2>
      <p className="mt-1 text-sm text-muted-foreground">Change ton prénom ou ta photo de profil.</p>
      <form
        className="card-warm mt-5 max-w-sm p-6 text-center"
        onSubmit={(e) => {
          e.preventDefault();
          const n = nameInput.trim();
          if (!n) return;
          onSave(n, avatarInput);
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        }}
      >
        <label className="block cursor-pointer">
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setAvatarInput(await resizeAvatar(file));
            }}
          />
          {avatarInput ? (
            <img
              src={avatarInput}
              alt="Ta photo de profil"
              className="mx-auto h-24 w-24 rounded-full border-2 border-primary object-cover"
            />
          ) : (
            <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full border-2 border-dashed border-primary/50 bg-accent text-3xl">
              📷
            </div>
          )}
          <span className="mt-2 block text-xs font-semibold text-primary">
            {avatarInput ? "Changer la photo" : "Choisir une photo de profil"}
          </span>
        </label>
        {avatarInput && (
          <button
            type="button"
            onClick={() => setAvatarInput(null)}
            className="mt-1 text-xs text-destructive hover:underline"
          >
            Retirer la photo
          </button>
        )}
        <input
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          maxLength={30}
          placeholder="Ton prénom"
          className="input-warm mt-4 w-full px-4 py-3 text-center"
        />
        <button type="submit" className="btn-autumn mt-4 w-full px-4 py-3 font-semibold">
          Enregistrer
        </button>
        {saved && <p className="mt-3 text-sm font-semibold text-primary">C'est enregistré 🍁</p>}
      </form>
      <p className="mt-3 max-w-sm text-xs text-muted-foreground">
        La nouvelle photo et le nouveau prénom s'appliquent à tes prochains messages.
      </p>
      <NotifButton name={name} />
      <button
        onClick={onShowTuto}
        className="card-warm mt-6 block max-w-sm px-4 py-3 text-sm font-semibold text-primary transition-colors hover:bg-accent"
      >
        🍂 Revoir le petit guide d'utilisation
      </button>
    </div>
  );
}

function urlB64ToUint8(b64: string) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

type NotifState = "idle" | "on" | "busy" | "denied" | "unsupported";

function notifSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function enablePush(name: string): Promise<NotifState> {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "denied" : "idle";
  const reg = await navigator.serviceWorker.register("/push-sw.js");
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8(VAPID_PUBLIC_KEY),
    }));
  const j = sub.toJSON();
  await savePushSubscription({
    data: { author: name, endpoint: sub.endpoint, p256dh: j.keys!["p256dh"]!, auth: j.keys!["auth"]! },
  });
  return "on";
}

function NotifButton({ name }: { name: string }) {
  const [state, setState] = useState<NotifState>("idle");

  useEffect(() => {
    if (!notifSupported()) {
      setState("unsupported");
    } else if (Notification.permission === "denied") setState("denied");
    else if (Notification.permission === "granted") {
      navigator.serviceWorker.getRegistration("/push-sw.js").then(async (r) => {
        if (r && (await r.pushManager.getSubscription())) setState("on");
      });
    }
  }, []);

  async function enable() {
    setState("busy");
    try {
      setState(await enablePush(name));
    } catch (e) {
      console.error(e);
      setState("idle");
      alert("Impossible d'activer les notifications ici. Vérifie les autorisations de P&H dans ton navigateur.");
    }
  }

  const label = {
    idle: "🔔 Activer les notifications",
    busy: "Activation…",
    on: "🔔 Notifications activées (renvoyer)",
    denied: "🔕 Notifications bloquées dans le navigateur",
    unsupported: "🔕 Notifications non disponibles ici",
  }[state];

  return (
    <button
      onClick={enable}
      disabled={state === "busy" || state === "unsupported" || state === "denied"}
      className="card-warm mt-6 block max-w-sm px-4 py-3 text-sm font-semibold text-primary transition-colors hover:bg-accent disabled:opacity-60"
    >
      {label}
    </button>
  );
}

// Demande automatique sur téléphone, tablette et ordinateur, tant que la permission n'est pas choisie
function NotifPrompt({ name }: { name: string }) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!notifSupported() || Notification.permission !== "default") return;
    const t = setTimeout(() => setVisible(true), 1500);
    return () => clearTimeout(t);
  }, []);

  if (!visible) return null;

  async function enable() {
    setBusy(true);
    try {
      const result = await enablePush(name);
      if (result === "on" || result === "denied") setVisible(false);
      else setBusy(false);
    } catch (e) {
      console.error(e);
      setBusy(false);
      alert("Impossible d'activer les notifications ici. Vérifie les autorisations de P&H dans ton navigateur.");
    }
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4">
      <div className="card-warm animate-fade-up w-full max-w-sm p-5 text-center shadow-lg">
        <p className="text-2xl">🔔</p>
        <p className="mt-1 font-semibold">Recevoir les messages de ton amour ?</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Tu seras prévenue même quand tu utilises un autre site ou une autre application.
        </p>
        <button
          onClick={enable}
          disabled={busy}
          className="btn-autumn mt-4 w-full px-4 py-2.5 font-semibold disabled:opacity-60"
        >
          {busy ? "Activation…" : "Activer les notifications"}
        </button>
        <button
          onClick={() => setVisible(false)}
          className="mt-2 text-xs text-muted-foreground hover:underline"
        >
          Plus tard
        </button>
      </div>
    </div>
  );
}

function VideosTab({ messages }: { messages: Message[] }) {
  const videos = messages.filter((m) => m.youtube_id);
  return (
    <div className="py-6">
      <h2 className="text-xl font-semibold">Nos vidéos 🎬</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Toutes les vidéos YouTube que vous vous êtes envoyées.
      </p>
      {videos.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          Aucune vidéo partagée pour l'instant. Utilise le bouton 🎬 dans les messages !
        </p>
      ) : (
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          {videos.map((m) => (
            <div key={m.id} className="card-warm animate-fade-up overflow-hidden">
              <YoutubeEmbed id={m.youtube_id!} />
              <div className="p-4">
                <p className="text-sm font-semibold text-primary">{m.author}</p>
                <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{m.content}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GifPicker({ onPick }: { onPick: (g: Gif) => void }) {
  const search = useServerFn(searchGifs);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 400);
    return () => clearTimeout(t);
  }, [q]);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["gifs", debounced],
    queryFn: () => search({ data: { q: debounced } }),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return (
    <div className="mb-2">
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Chercher un GIF…"
        className="input-warm mb-2 w-full px-3 py-2 text-sm"
      />
      <div className="grid max-h-64 grid-cols-3 gap-1.5 overflow-y-auto sm:grid-cols-4">
        {isLoading && <p className="col-span-full py-4 text-center text-sm text-muted-foreground">Chargement…</p>}
        {isError && <p className="col-span-full py-4 text-center text-sm text-muted-foreground">GIF indisponibles pour le moment</p>}
        {data?.map((g) => (
          <button key={g.id} type="button" onClick={() => onPick(g)} className="overflow-hidden rounded-lg">
            <img src={g.preview} alt={g.title} loading="lazy" className="h-24 w-full object-cover transition-transform hover:scale-105" />
          </button>
        ))}
      </div>
    </div>
  );
}
