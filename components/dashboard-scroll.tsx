"use client";

import React from "react";
import { createRoot } from "react-dom/client";
import { HeroScrollDemo } from "./ui/demo.js";

// Îlot React autonome : ne modifie pas le routage ni le reste du site statique.
const mount = document.querySelector<HTMLElement>("[data-dashboard-react-root]");
if (mount) {
  createRoot(mount).render(<HeroScrollDemo />);
}
