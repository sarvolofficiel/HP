import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { unlockSite } from "@/lib/gate.functions";

export const Route = createFileRoute("/unlock")({
  head: () => ({
    meta: [
      { title: "P&H — Entrer" },
      { name: "description", content: "Un espace rien qu'à nous deux." },
      { property: "og:title", content: "P&H — Entrer" },
      { property: "og:description", content: "Un espace rien qu'à nous deux." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Unlock,
});

function Unlock() {
  const router = useRouter();
  const unlock = useServerFn(unlockSite);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(false);
    const password = new FormData(e.currentTarget).get("password") as string;
    const { ok } = await unlock({ data: { password } });
    setPending(false);
    if (ok) await router.navigate({ to: "/" });
    else setError(true);
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 0%, oklch(0.9 0.06 70 / 0.5), transparent), radial-gradient(40% 35% at 85% 90%, oklch(0.85 0.08 55 / 0.35), transparent)",
        }}
      />
      <span aria-hidden className="animate-leaf absolute left-[12%] top-[18%] text-4xl opacity-60">🍂</span>
      <span aria-hidden className="animate-leaf absolute right-[15%] top-[30%] text-3xl opacity-50" style={{ animationDelay: "1.5s" }}>🍁</span>
      <span aria-hidden className="animate-leaf absolute bottom-[20%] left-[25%] text-2xl opacity-40" style={{ animationDelay: "3s" }}>🍂</span>

      <form onSubmit={onSubmit} className="card-warm animate-fade-up relative w-full max-w-sm p-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-2xl">💛</div>
        <h1 className="text-3xl font-semibold text-foreground">P&H</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Juste ma hibiscus et son pipou
        </p>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          placeholder="Notre mot de passe"
          className="input-warm mt-6 w-full px-4 py-3 text-center text-base"
        />
        {error && (
          <p className="mt-3 text-sm text-destructive">Ce n'est pas le bon mot de passe… réessaie 💫</p>
        )}
        <button type="submit" disabled={pending} className="btn-autumn mt-5 w-full px-4 py-3 font-semibold">
          {pending ? "Ouverture…" : "Entrer"}
        </button>
      </form>
    </div>
  );
}
