import { Route, Routes } from "react-router-dom";
import Wizard from "./Wizard";
import PublishedView from "./PublishedView";

/**
 * Rutas de la app:
 *   "/"     → asistente por pasos (crear una pieza)
 *   "/p/:id" → vista publicada (lo que lee el usuario final)
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Wizard />} />
      <Route path="/p/:id" element={<PublishedView />} />
      <Route path="*" element={<Wizard />} />
    </Routes>
  );
}
