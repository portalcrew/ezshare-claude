import "./styles.css";
import { mountLauncher } from "./mount.tsx";

const root = document.querySelector<HTMLElement>("#app");
// GitHub Pages cannot send frame-ancestors, so a framed launcher refuses to render (clickjacking defense).
if (root !== null && window.top === window.self) {
    let unmount = mountLauncher(root);
    window.addEventListener("pagehide", () => unmount());
    window.addEventListener("pageshow", (event) => {
        if (event.persisted) {
            unmount = mountLauncher(root);
        }
    });
}
