import { render } from "preact";
import { App } from "./app";
import "./styles.css";

document.getElementById("boot")?.remove();
const root = document.getElementById("root");
if (root !== null) render(<App />, root);

if ("serviceWorker" in navigator) {
	// A failed registration only costs the offline shell, never the app.
	void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
}
