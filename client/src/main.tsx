import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// The app uses hash-based routing. When a route is opened directly by path
// (e.g. /admin/login), seed the hash from that path so it resolves to the
// matching route. Otherwise the path is discarded and the app always renders
// the root trainee login, whose form posts to /api/login and rejects admins.
if (!window.location.hash) {
  const { pathname, search } = window.location;
  const route = pathname && pathname !== "/" ? pathname + search : "/";
  window.history.replaceState(null, "", "/#" + route);
}

createRoot(document.getElementById("root")!).render(<App />);
