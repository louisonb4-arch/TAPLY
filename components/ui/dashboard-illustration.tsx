"use client";

import React from "react";
import { ContainerScroll } from "./container-scroll-animation.js";

/**
 * Aperçu marketing de l’interface Taply :
 * on emploie le véritable dashboard existant, plutôt qu'une image Unsplash
 * sans rapport avec le produit. Le titre marketing reste en HTML adjacent.
 */
export function MerchantDashboardIllustration() {
  return (
    <ContainerScroll titleComponent={null}>
      <img
        src="images/dashboard-interface.png"
        alt="Aperçu du tableau de bord commerçant Taply : clients, visites, statistiques et récompenses (données illustratives)."
        width={1440}
        height={910}
        loading="lazy"
        decoding="async"
        draggable={false}
        className="dashboard-scroll-image block h-auto w-full object-cover object-left-top"
      />
    </ContainerScroll>
  );
}
