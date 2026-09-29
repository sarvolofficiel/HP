import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

type Status = "idle" | "waiting" | "connecting" | "connected";

const ICE: RTCConfiguration = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ],
};

/**
 * Chaîne anti-bruit maison (Web Audio) :
 * filtre passe-haut (souffle, ronflements) → passe-bas (sifflements aigus)
 * → compresseur → porte de bruit (coupe le micro quand personne ne parle).
 */
function buildNoiseFilter(input: MediaStream) {
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(input);

  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 100;

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 7500;

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -40;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.005;
  compressor.release.value = 0.2;

  const gate = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;

  const dest = ctx.createMediaStreamDestination();
  src.connect(highpass).connect(lowpass).connect(compressor);
  compressor.connect(analyser);
  compressor.connect(gate).connect(dest);

  const buf = new Float32Array(analyser.fftSize);
  let enabled = true;
  let noiseFloor = 0.01;
  let openUntil = 0;
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const x = buf[i] ?? 0; sum += x * x; }
    const rms = Math.sqrt(sum / buf.length);
    const now = ctx.currentTime;
    // Apprend lentement le niveau du bruit ambiant
    if (rms < noiseFloor * 2) noiseFloor = noiseFloor * 0.98 + rms * 0.02;
    const threshold = Math.max(0.008, noiseFloor * 2.5);
    if (!enabled || rms > threshold) openUntil = now + 0.25; // garde ouvert un peu après la voix
    const target = now < openUntil ? 1 : 0.03;
    gate.gain.setTargetAtTime(target, now, target === 1 ? 0.01 : 0.08);
  }, 20);

  return {
    track: dest.stream.getAudioTracks()[0]!,
    setEnabled(v: boolean) {
      enabled = v;
      highpass.frequency.value = v ? 100 : 10;
      lowpass.frequency.value = v ? 7500 : 20000;
    },
    stop() {
      window.clearInterval(timer);
      ctx.close();
    },
  };
}

function CallAvatar({ src, name, size = "h-20 w-20" }: { src: string | null; name: string; size?: string }) {
  if (src) {
    return <img src={src} alt={name} className={`${size} rounded-full border-2 border-card object-cover shadow-lg`} />;
  }
  return (
    <div className={`flex ${size} items-center justify-center rounded-full border-2 border-card bg-accent text-2xl font-bold text-primary shadow-lg`}>
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

export function CallRoom({ name, avatar }: { name: string; avatar: string | null }) {
  const [status, setStatus] = useState<Status>("idle");
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [antiNoise, setAntiNoise] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [peerName, setPeerName] = useState<string | null>(null);
  const [peerAvatar, setPeerAvatar] = useState<string | null>(null);

  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const channel = useRef<RealtimeChannel | null>(null);
  const rawStream = useRef<MediaStream | null>(null);
  const sendStream = useRef<MediaStream | null>(null);
  const filter = useRef<ReturnType<typeof buildNoiseFilter> | null>(null);
  const myId = useRef(crypto.randomUUID());
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);

  const send = (event: string, payload: Record<string, unknown> = {}) =>
    channel.current?.send({ type: "broadcast", event, payload: { ...payload, from: myId.current, name, avatar } });

  const newPeer = () => {
    pc.current?.close();
    const peer = new RTCPeerConnection(ICE);
    sendStream.current?.getTracks().forEach((t) => peer.addTrack(t, sendStream.current!));
    peer.ontrack = (e) => {
      if (remoteVideo.current) remoteVideo.current.srcObject = e.streams[0] ?? null;
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") setStatus("connected");
      if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
        setStatus((s) => (s === "idle" ? s : "waiting"));
        setPeerName(null);
      }
    };
    pc.current = peer;
    pendingIce.current = [];
    return peer;
  };

  // Attend que tous les chemins réseau soient trouvés, puis les envoie en un seul message
  const gathered = (peer: RTCPeerConnection) =>
    new Promise<RTCSessionDescriptionInit | null>((resolve) => {
      const done = () => resolve(peer.localDescription?.toJSON() ?? null);
      if (peer.iceGatheringState === "complete") return done();
      const t = window.setTimeout(done, 3000);
      peer.addEventListener("icegatheringstatechange", () => {
        if (peer.iceGatheringState === "complete") { window.clearTimeout(t); done(); }
      });
    });

  const flushIce = async () => {
    for (const c of pendingIce.current) await pc.current?.addIceCandidate(c).catch(() => {});
    pendingIce.current = [];
  };

  const start = async () => {
    setError(null);
    try {
      const raw = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      rawStream.current = raw;
      filter.current = buildNoiseFilter(raw);
      filter.current.setEnabled(antiNoise);
      sendStream.current = new MediaStream([...raw.getVideoTracks(), filter.current.track]);
      if (localVideo.current) localVideo.current.srcObject = new MediaStream(raw.getVideoTracks());
    } catch {
      setError("Impossible d'accéder à la caméra ou au micro. Autorise-les dans ton navigateur.");
      return;
    }

    const ch = supabase.channel("couple-call", { config: { broadcast: { self: false } } });
    ch.on("broadcast", { event: "hello" }, async ({ payload }) => {
      if (payload.from === myId.current) return;
      setPeerName(payload.name);
      setPeerAvatar((payload.avatar as string | null) ?? null);
      setStatus("connecting");
      const peer = newPeer();
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      send("offer", { to: payload.from, sdp: await gathered(peer) });
    })
      .on("broadcast", { event: "offer" }, async ({ payload }) => {
        if (payload.to !== myId.current) return;
        setPeerName(payload.name);
        setPeerAvatar((payload.avatar as string | null) ?? null);
        setStatus("connecting");
        const peer = newPeer();
        await peer.setRemoteDescription(payload.sdp);
        await flushIce();
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        send("answer", { to: payload.from, sdp: await gathered(peer) });
      })
      .on("broadcast", { event: "answer" }, async ({ payload }) => {
        if (payload.to !== myId.current || !pc.current) return;
        await pc.current.setRemoteDescription(payload.sdp);
        await flushIce();
      })
      .on("broadcast", { event: "ice" }, async ({ payload }) => {
        if (payload.from === myId.current) return;
        if (pc.current?.remoteDescription) {
          await pc.current.addIceCandidate(payload.candidate).catch(() => {});
        } else pendingIce.current.push(payload.candidate);
      })
      .on("broadcast", { event: "bye" }, () => {
        pc.current?.close();
        pc.current = null;
        if (remoteVideo.current) remoteVideo.current.srcObject = null;
        setPeerName(null);
        setStatus("waiting");
      })
      .subscribe((s) => {
        if (s === "SUBSCRIBED") {
          setStatus("waiting");
          send("hello");
        }
      });
    channel.current = ch;
  };

  const hangUp = () => {
    send("bye");
    pc.current?.close();
    pc.current = null;
    if (channel.current) supabase.removeChannel(channel.current);
    channel.current = null;
    rawStream.current?.getTracks().forEach((t) => t.stop());
    filter.current?.stop();
    filter.current = null;
    if (remoteVideo.current) remoteVideo.current.srcObject = null;
    if (localVideo.current) localVideo.current.srcObject = null;
    setPeerName(null);
    setStatus("idle");
  };

  useEffect(() => () => hangUp(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMic = () => {
    const v = !micOn;
    sendStream.current?.getAudioTracks().forEach((t) => (t.enabled = v));
    setMicOn(v);
  };
  const toggleCam = () => {
    const v = !camOn;
    rawStream.current?.getVideoTracks().forEach((t) => (t.enabled = v));
    setCamOn(v);
  };
  const toggleNoise = () => {
    const v = !antiNoise;
    filter.current?.setEnabled(v);
    setAntiNoise(v);
  };

  const statusText: Record<Status, string> = {
    idle: "Prêt·e à appeler",
    waiting: "En attente de ta moitié… 💭",
    connecting: `Connexion avec ${peerName ?? "ta moitié"}…`,
    connected: `En appel avec ${peerName ?? "ta moitié"} 💞`,
  };

  return (
    <div className="flex flex-1 flex-col py-6">
      <div className="card-warm mb-4 p-5 text-center">
        <h2 className="text-xl font-semibold">Appel vidéo 📞</h2>
        <p className="mt-1 text-sm text-muted-foreground">{statusText[status]}</p>
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </div>

      <div className="card-warm relative flex-1 overflow-hidden bg-foreground/90">
        <video
          ref={remoteVideo}
          autoPlay
          playsInline
          className="h-full min-h-[420px] w-full object-cover"
        />
        {status !== "connected" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
            <div className="flex items-center gap-6">
              <div className="flex flex-col items-center gap-1.5">
                <CallAvatar src={avatar} name={name} />
                <span className="text-xs font-semibold text-card">{name}</span>
              </div>
              {peerName && (
                <>
                  <span className="text-2xl">💞</span>
                  <div className="flex flex-col items-center gap-1.5">
                    <CallAvatar src={peerAvatar} name={peerName} />
                    <span className="text-xs font-semibold text-card">{peerName}</span>
                  </div>
                </>
              )}
            </div>
            {!peerName && <span className="text-3xl">🍂</span>}
          </div>
        )}
        {status === "connected" && peerName && (
          <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-card/80 py-1 pl-1 pr-3 backdrop-blur">
            <CallAvatar src={peerAvatar} name={peerName} size="h-7 w-7" />
            <span className="text-xs font-semibold">{peerName}</span>
          </div>
        )}
        <video
          ref={localVideo}
          autoPlay
          playsInline
          muted
          className={`absolute bottom-3 right-3 w-32 rounded-xl border-2 border-card object-cover shadow-lg sm:w-44 ${
            status === "idle" || !camOn ? "hidden" : ""
          }`}
          style={{ transform: "scaleX(-1)" }}
        />
        {status !== "idle" && !camOn && (
          <div className="absolute bottom-3 right-3">
            <CallAvatar src={avatar} name={name} size="h-16 w-16" />
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {status === "idle" ? (
          <button onClick={start} className="btn-autumn px-6 py-3">
            📞 Rejoindre l'appel
          </button>
        ) : (
          <>
            <button onClick={toggleMic} className="rounded-full bg-card px-4 py-2 text-sm font-semibold shadow">
              {micOn ? "🎙️ Micro" : "🔇 Muet"}
            </button>
            <button onClick={toggleCam} className="rounded-full bg-card px-4 py-2 text-sm font-semibold shadow">
              {camOn ? "📷 Caméra" : "🚫 Caméra"}
            </button>
            <button
              onClick={toggleNoise}
              className={`rounded-full px-4 py-2 text-sm font-semibold shadow ${
                antiNoise ? "bg-primary text-primary-foreground" : "bg-card"
              }`}
            >
              {antiNoise ? "🌿 Anti-bruit activé" : "🌿 Anti-bruit coupé"}
            </button>
            <button
              onClick={hangUp}
              className="rounded-full bg-destructive px-5 py-2 text-sm font-semibold text-destructive-foreground shadow"
            >
              Raccrocher
            </button>
          </>
        )}
      </div>
    </div>
  );
}
