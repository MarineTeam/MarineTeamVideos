import { useState } from "react";
import { kvGet } from "../../lib/kv";
import { isGrantSpent, markGrantSpent } from "../../lib/singleUse";
import { decideBundleAccess } from "../../lib/bundleAccess";
import { getBundleMembers } from "../../lib/bundles";
import { getSettings } from "../../lib/settings";
import { isGeoAllowed, recipientGeoWhitelist } from "../../lib/geo";
import { runWithMonitor, getMonitorSnapshot } from "../../lib/monitor";
import QueryMonitorBar from "../../components/QueryMonitorBar";

export default function BundlePage({ status, reason, bundleId, items, notice, monitor }) {
  if (status === "invalid") {
    return (
      <div className="recipient-page">
        <div className="recipient-card">
          <h2 style={{ marginTop: 0 }}>This link isn't available</h2>
          <p style={styles.muted}>{reason}</p>
        </div>
        <QueryMonitorBar data={monitor} />
      </div>
    );
  }

  if (status === "authorized") {
    return (
      <div className="recipient-page">
        <div className="recipient-card">
          <h2 style={{ marginTop: 0 }}>Your shared videos</h2>
          <ul style={styles.list}>
            {items.map((it) => (
              <li key={it.token} style={styles.item}>
                {it.status === "active" ? (
                  <a href={it.link}>{it.videoTitle}</a>
                ) : (
                  <span style={styles.muted}>
                    {it.videoTitle} — {it.status}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
        <QueryMonitorBar data={monitor} />
      </div>
    );
  }

  return (
    <>
      <BundleEmailGate bundleId={bundleId} notice={notice} />
      <QueryMonitorBar data={monitor} />
    </>
  );
}

function BundleEmailGate({ bundleId, notice }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState("idle"); // idle | sending | sent | error
  const [message, setMessage] = useState("");

  async function submit(e) {
    e.preventDefault();
    setState("sending");
    setMessage("");
    try {
      const res = await fetch("/api/bundle/request-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundleId, email }),
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
            Click the link in that email to view your videos. It expires shortly, so
            if it's been a while just request a new one.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="recipient-page">
      <div className="recipient-card">
        <h2 style={{ marginTop: 0 }}>Confirm your email to view your shared videos</h2>
        <p style={styles.muted}>
          These videos were shared privately. Enter the email address they were
          shared with and we'll send you a one-time sign-in link.
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
    const result = await bundleProps(ctx);
    if (result.props) {
      const snapshot = getMonitorSnapshot();
      if (snapshot) result.props.monitor = snapshot;
    }
    return result;
  });
}

async function bundleProps({ params, query, req, res }) {
  const { bundleId } = params;
  const bundle = await kvGet(`bunnybundle:${bundleId}`);
  const settings = await getSettings();

  const proto =
    req.headers["x-forwarded-proto"] ||
    ((process.env.SITE_URL || "").startsWith("https") ? "https" : "http");

  // Every branch lives in lib/bundleAccess.js so it can be tested without
  // importing this JSX file (roadmap item (r)). This function only gathers
  // facts and applies the effects the decision asks for. `loadMembers` is
  // injected rather than called up front so the member records are still
  // only read on the paths that actually need them.
  const decision = await decideBundleAccess({
    bundleId,
    bundle,
    grant: query.grant,
    cookies: parseCookies(req.headers.cookie),
    geoAllowed: !settings.geoWhitelistEnabled || isGeoAllowed(req, recipientGeoWhitelist()),
    secure: proto === "https",
    isSpent: isGrantSpent,
    loadMembers: () => getBundleMembers(bundle.tokens),
  });

  if (decision.kind === "invalid") {
    return { props: { status: "invalid", reason: decision.reason } };
  }

  if (decision.kind === "exchange") {
    await markGrantSpent(decision.spend.grant, decision.spend.expiresAt);
    res.setHeader("Set-Cookie", decision.setCookies);
    return { redirect: { destination: decision.redirectTo, permanent: false } };
  }

  if (decision.kind === "authorized") {
    return { props: { status: "authorized", bundleId, items: decision.items } };
  }

  return {
    props: {
      status: "need-email",
      bundleId,
      ...(decision.notice ? { notice: decision.notice } : {}),
    },
  };
}

const styles = {
  list: { paddingLeft: 20, margin: 0 },
  item: { marginBottom: 8 },
  muted: { color: "#57606a" },
  notice: { color: "#9a6700", background: "#fff8c5", padding: "8px 12px", borderRadius: 6 },
  error: { color: "#d1242f" },
  form: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 },
};
