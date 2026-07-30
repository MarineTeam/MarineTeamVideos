import { useEffect } from "react";
import "../styles/globals.css";
import { installFetchMonitor } from "../lib/clientMonitorStore";

export default function App({ Component, pageProps }) {
  // No-op unless the server is actually attaching X-Query-Monitor headers
  // (QUERY_MONITOR on) — see lib/clientMonitorStore.js.
  useEffect(() => {
    installFetchMonitor();
  }, []);

  return <Component {...pageProps} />;
}
