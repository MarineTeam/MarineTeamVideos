import { useCallback, useEffect, useRef, useState } from "react";
import { kvGet, kvSet } from "../../lib/kv";
import { generateEmbedUrl } from "../../lib/bunny";
import { isGrantSpent, markGrantSpent } from "../../lib/singleUse";
import { recordGrantExchange } from "../../lib/gateLog";
import { clientIp } from "../../lib/rateLimit";
import { getSettings } from "../../lib/settings";
import { decideWatchAccess } from "../../lib/watchAccess";
import { isGeoAllowed, recipientGeoWhitelist } from "../../lib/geo";
import { runWithMonitor, getMonitorSnapshot } from "../../lib/monitor";
import QueryMonitorBar from "../../components/QueryMonitorBar";

export default function WatchPage({
  status,
  reason,
  embedUrl,
  title,
  token,
  notice,
  trackAuth,
  watermarkText,
  resumeSec,
  durationSec,
  canRequestAccess,
  monitor,
}) {
  if (status === "invalid") {
    return (
      <div className="recipient-page">
        <div className="recipient-card">
          <h2 style={{ marginTop: 0 }}>This link isn't available</h2>
          <p style={styles.muted}>{reason}</p>
          {canRequestAccess && <RequestAccess token={token} />}
        </div>
        <QueryMonitorBar data={monitor} />
      </div>
    );
  }

  if (status === "authorized") {
    return (
      <>
        <Player
          embedUrl={embedUrl}
          title={title}
          token={token}
          trackAuth={trackAuth}
          watermarkText={watermarkText}
          resumeSec={resumeSec}
          durationSec={durationSec}
        />
        <QueryMonitorBar data={monitor} />
      </>
    );
  }

  return (
    <>
      <EmailGate token={token} title={title} notice={notice} />
      <QueryMonitorBar data={monitor} />
    </>
  );
}

// Shown only under an EXPIRED link (never a revoked or unknown one — see
// the getServerSideProps branch that sets canRequestAccess). Lets the
// recipient ask the owner for more time instead of the page being a dead
// end. The response is deliberately the same whatever happens server-side,
// so this form can't be used to probe whose address a link belongs to.
function RequestAccess({ token }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState("idle");

  async function submit(e) {
    e.preventDefault();
    setState("sending");
    try {
      await fetch("/api/watch/request-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, email }),
      });
    } catch {}
    setState("sent");
  }

  if (state === "sent") {
    return (
      <p style={styles.muted}>
        If that email matches this link, we've let the owner know. They can
        extend it without changing the link you already have.
      </p>
    );
  }

  return (
    <>
      <p style={styles.muted}>Need more time? Ask the owner to extend it.</p>
      <form onSubmit={submit} style={styles.form}>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@email.com"
          className="input"
          style={{ flex: "1 1 240px" }}
          aria-label="Your email address"
        />
        <button type="submit" disabled={state === "sending"} className="btn btn-primary">
          {state === "sending" ? "Sending..." : "Request more time"}
        </button>
      </form>
    </>
  );
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

// The watermark is a client-side overlay of the viewer's verified email tiled
// over the player, plus one drifting copy so a fixed crop can't remove every
// instance. It deters casual re-sharing / screen-recording by making a leaked
// recording trace back to one recipient. Honest limit: it is DOM over a
// cross-origin iframe, not burned into the video pixels (that would need
// per-view server-side transcoding Bunny doesn't expose here) — a determined
// viewer can strip it via devtools. It raises the effort and attributes leaks;
// it is not DRM.
function Watermark({ text }) {
  if (!text) return null;
  return (
    <div style={styles.wmOverlay} aria-hidden="true">
      <style
        dangerouslySetInnerHTML={{
          __html:
            "@keyframes wmDrift{0%{top:6%;left:-12%}25%{top:78%;left:66%}50%{top:38%;left:18%}75%{top:12%;left:82%}100%{top:6%;left:-12%}}",
        }}
      />
      <div style={styles.wmTile}>
        {Array.from({ length: 72 }).map((_, i) => (
          <span key={i} style={styles.wmText}>
            {text}
          </span>
        ))}
      </div>
      <span style={styles.wmMover}>{text}</span>
    </div>
  );
}

function Player({ embedUrl, title, token, trackAuth, watermarkText, resumeSec, durationSec }) {
  const iframeRef = useRef(null);

  // Offer to resume only when there's a meaningful saved position that isn't
  // basically the end of the video (finished ≈ start over next time).
  const canResume =
    resumeSec >= 15 && (!durationSec || resumeSec <= durationSec - 15);
  const [showResume, setShowResume] = useState(canResume);

  // Post a Player.js command to the Bunny embed. iframeRef is stable, so this
  // is safe to share between the resume button and the tracking effect.
  const post = useCallback((msg) => {
    const iframe = iframeRef.current;
    if (!iframe || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.postMessage(
        JSON.stringify({ context: "player.js", version: "0.0.11", ...msg }),
        "*"
      );
    } catch {}
  }, []);

  function resume() {
    post({ method: "setCurrentTime", value: Math.floor(resumeSec) });
    post({ method: "play" });
    setShowResume(false);
  }

  // Playback tracking via the Player.js postMessage protocol, which the Bunny
  // embed player speaks. Reports: first play, 25/50/75% progress milestones,
  // completion, and a throttled playback position (for resume). Fire-and-forget
  // — tracking failures never affect playback.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !trackAuth) return;

    let played = false;
    const milestones = new Set();
    let lastSeconds = 0;
    let lastDuration = 0;
    let lastPosReport = 0; // seconds of playback at last position report

    function subscribe() {
      for (const ev of ["play", "pause", "timeupdate", "ended"]) {
        post({ method: "addEventListener", value: ev });
      }
    }

    function track(event, extra) {
      fetch("/api/watch/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, auth: trackAuth, event, ...extra }),
        keepalive: true,
      }).catch(() => {});
    }

    function reportPosition() {
      if (lastSeconds <= 0) return;
      track("position", { positionSec: lastSeconds, durationSec: lastDuration || undefined });
    }

    function onMessage(e) {
      if (e.source !== iframe.contentWindow) return;
      let d = e.data;
      if (typeof d === "string") {
        try {
          d = JSON.parse(d);
        } catch {
          return;
        }
      }
      if (!d || d.context !== "player.js") return;

      if (d.event === "ready") subscribe();
      if (d.event === "play" && !played) {
        played = true;
        track("play");
      }
      if (d.event === "timeupdate" && d.value && d.value.duration > 0) {
        lastSeconds = d.value.seconds;
        lastDuration = d.value.duration;
        const pct = Math.floor((d.value.seconds / d.value.duration) * 100);
        for (const m of [25, 50, 75]) {
          if (pct >= m && !milestones.has(m)) {
            milestones.add(m);
            track("progress", { progressPct: m });
          }
        }
        // Throttle position reports to at most once every 15s of playback,
        // so resume stays current without hammering KV on every timeupdate.
        if (d.value.seconds - lastPosReport >= 15) {
          lastPosReport = d.value.seconds;
          reportPosition();
        }
      }
      // Capture the stopping point promptly when the viewer pauses or leaves.
      if (d.event === "pause") reportPosition();
      if (d.event === "ended" && !milestones.has(100)) {
        milestones.add(100);
        track("ended", { progressPct: 100 });
      }
    }

    function onHide() {
      if (document.visibilityState === "hidden") reportPosition();
    }

    window.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onHide);
    // Subscribe on load too, in case the player's "ready" fired before our
    // listener attached. Duplicate subscriptions are harmless (flags above
    // dedupe our reports).
    iframe.addEventListener("load", subscribe);
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onHide);
      iframe.removeEventListener("load", subscribe);
    };
  }, [token, trackAuth, post]);

  return (
    <div className="recipient-page wide">
      <div className="recipient-card" style={styles.playerCard}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <div style={styles.playerBox}>
        <iframe
          ref={iframeRef}
          src={embedUrl}
          loading="lazy"
          style={styles.iframe}
          allow="accelerometer;gyroscope;autoplay;encrypted-media;picture-in-picture;"
          allowFullScreen
        />
        <Watermark text={watermarkText} />
        {showResume && (
          <div style={styles.resumeBar}>
            <span>You left off at {formatTime(resumeSec)}.</span>
            <button onClick={resume} style={styles.resumeBtn}>
              Resume
            </button>
            <button onClick={() => setShowResume(false)} style={styles.resumeBtnSecondary}>
              Start over
            </button>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

function EmailGate({ token, title, notice }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState("idle"); // idle | sending | sent | error
  const [message, setMessage] = useState("");

  async function submit(e) {
    e.preventDefault();
    setState("sending");
    setMessage("");
    try {
      const res = await fetch("/api/watch/request-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, email }),
      });
      const data = await res.json();
      if (res.ok) {
        setState("sent");
        setMessage(data.message || "Check your email for a sign-in link.");
      } else {
        setState("error");
        setMessage(data.error || "Something went wrong. Please try again.");
      }
    } catch {
      setState("error");
      setMessage("Something went wrong. Please try again.");
    }
  }

  if (state === "sent") {
    return (
      <div className="recipient-page">
        <div className="recipient-card">
          <h2 style={{ marginTop: 0 }}>Check your email</h2>
          <p>{message}</p>
          <p style={styles.muted}>
            Click the link in that email to start watching. It expires shortly, so
            if it's been a while just request a new one.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="recipient-page">
      <div className="recipient-card">
        <h2 style={{ marginTop: 0 }}>Confirm your email to watch{title ? ` "${title}"` : ""}</h2>
        <p style={styles.muted}>
          This video was shared privately. Enter the email address it was shared
          with and we'll send you a one-time sign-in link.
        </p>
        {notice && <p style={styles.notice}>{notice}</p>}
        <form onSubmit={submit} style={styles.form}>
          <input
            type="email"
            required
            placeholder="you@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
            style={{ flex: "1 1 240px" }}
          />
          <button type="submit" disabled={state === "sending"} className="btn btn-primary">
            {state === "sending" ? "Sending..." : "Email me a sign-in link"}
          </button>
        </form>
        {state === "error" && <p style={styles.error}>{message}</p>}
      </div>
    </div>
  );
}

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

export async function getServerSideProps(ctx) {
  return runWithMonitor(async () => {
    const result = await watchProps(ctx);
    if (result.props) {
      const snapshot = getMonitorSnapshot();
      if (snapshot) result.props.monitor = snapshot;
    }
    return result;
  });
}

async function watchProps({ params, query, req, res }) {
  const { token } = params;
  const record = await kvGet(`bunnyshare:${token}`);
  const settings = await getSettings();

  const proto =
    req.headers["x-forwarded-proto"] ||
    ((process.env.SITE_URL || "").startsWith("https") ? "https" : "http");

  // Every branch of the access decision lives in lib/watchAccess.js so it can
  // be tested without importing this JSX file (roadmap item (r)). This
  // function only gathers facts and applies the effects the decision asks
  // for — no branching logic of its own.
  const decision = await decideWatchAccess({
    token,
    record,
    settings,
    grant: query.grant,
    cookies: parseCookies(req.headers.cookie),
    geoAllowed: !settings.geoWhitelistEnabled || isGeoAllowed(req, recipientGeoWhitelist()),
    secure: proto === "https",
    isSpent: isGrantSpent,
  });

  if (decision.kind === "invalid") {
    return {
      props: {
        status: "invalid",
        reason: decision.reason,
        ...(decision.canRequestAccess ? { token, canRequestAccess: true } : {}),
      },
    };
  }

  if (decision.kind === "exchange") {
    // Spend the grant at the moment of the cookie-setting exchange, never on
    // any other path (see lib/singleUse.js for why that placement matters).
    await markGrantSpent(decision.spend.grant, decision.spend.expiresAt);
    // Audit the moment access was actually granted (lib/gateLog.js).
    // Best-effort by construction — it never throws — so it cannot turn a
    // legitimate sign-in into a failure.
    await recordGrantExchange({
      kind: "watch",
      token: token,
      email: record.email,
      ip: clientIp(req),
    });
    res.setHeader("Set-Cookie", decision.setCookie);
    return { redirect: { destination: decision.redirectTo, permanent: false } };
  }

  if (decision.kind === "authorized") {
    await kvSet(`bunnyshare:${token}`, decision.viewUpdate);
    return {
      props: {
        status: "authorized",
        embedUrl: generateEmbedUrl(decision.videoId, 3600),
        title: decision.title,
        token,
        trackAuth: decision.trackAuth,
        watermarkText: decision.watermarkText,
        resumeSec: decision.resumeSec,
        durationSec: decision.durationSec,
      },
    };
  }

  return {
    props: {
      status: "need-email",
      token,
      title: decision.title,
      ...(decision.notice ? { notice: decision.notice } : {}),
    },
  };
}

const styles = {
  playerCard: { maxWidth: 960, width: "100%" },
  playerBox: { position: "relative", paddingTop: "56.25%", borderRadius: 8, overflow: "hidden" },
  iframe: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", border: 0 },
  muted: { color: "#57606a" },
  notice: { color: "#9a6700", background: "#fff8c5", padding: "8px 12px", borderRadius: 6 },
  error: { color: "#d1242f" },
  form: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 },
  // Watermark overlay. pointerEvents:none so the player's own controls stay
  // fully usable underneath. Low opacity keeps it non-intrusive.
  wmOverlay: { position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 2 },
  wmTile: {
    position: "absolute",
    top: "-25%",
    left: "-25%",
    width: "150%",
    height: "150%",
    display: "flex",
    flexWrap: "wrap",
    gap: "42px 70px",
    transform: "rotate(-30deg)",
    alignContent: "center",
    justifyContent: "center",
  },
  wmText: {
    color: "rgba(255,255,255,0.10)",
    fontSize: 15,
    fontFamily: "system-ui, sans-serif",
    whiteSpace: "nowrap",
    textShadow: "0 0 2px rgba(0,0,0,0.18)",
  },
  wmMover: {
    position: "absolute",
    color: "rgba(255,255,255,0.20)",
    fontSize: 15,
    fontWeight: 600,
    whiteSpace: "nowrap",
    textShadow: "0 0 3px rgba(0,0,0,0.45)",
    animation: "wmDrift 23s linear infinite",
  },
  resumeBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 14px",
    background: "rgba(0,0,0,0.72)",
    color: "white",
    fontSize: 14,
    zIndex: 3,
  },
  resumeBtn: { background: "#1f6feb", color: "white", border: 0, padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 14 },
  resumeBtnSecondary: { background: "rgba(255,255,255,0.18)", color: "white", border: 0, padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 14 },
};
