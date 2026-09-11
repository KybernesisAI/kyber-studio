import React from "react";
import { createRoot } from "react-dom/client";
import { OrbApp } from "./orb/OrbApp";

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <OrbApp />
  </React.StrictMode>,
);
