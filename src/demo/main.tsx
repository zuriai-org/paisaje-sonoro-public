import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "../converter/converter.css";
import "../player/player.css";
import "./demo.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root no encontrado en el DOM");

createRoot(rootEl).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
