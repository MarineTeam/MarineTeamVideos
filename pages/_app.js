import "../styles/globals.css";
// Side-effect import: installs the fetch monitor patch at module load, before
// any page's mount effects run. See lib/clientMonitorStore.js.
import "../lib/clientMonitorStore";

export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />;
}
