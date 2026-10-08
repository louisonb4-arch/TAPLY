"use client";

import React, { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import type { MotionValue } from "framer-motion";

/**
 * Aceternity ContainerScroll, adapté à une section de landing page existante.
 * Animation attachée à la position réelle du composant, réversible au scroll.
 * Le titre peut être rendu par la colonne de contenu HTML adjacente.
 */
export const ContainerScroll = ({
  titleComponent,
  children,
}: {
  titleComponent: string | React.ReactNode;
  children: React.ReactNode;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isMobile, setIsMobile] = useState(false);
  const reducedMotion = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start end", "end start"],
  });

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  const rotate = useTransform(scrollYProgress, [0, 1], isMobile ? [0, 0] : [22, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], isMobile ? [1, 1] : [0.88, 1.02]);
  const translate = useTransform(scrollYProgress, [0, 1], isMobile ? [0, 0] : [32, -18]);

  return (
    <div className="dashboard-scroll-container relative flex w-full items-center justify-center" ref={containerRef}>
      <div className="dashboard-scroll-perspective relative w-full" style={{ perspective: "1200px" }}>
        {titleComponent ? <Header translate={translate} titleComponent={titleComponent} /> : null}
        <Card rotate={rotate} scale={scale} translate={translate} staticMotion={Boolean(reducedMotion) || isMobile}>
          {children}
        </Card>
      </div>
    </div>
  );
};

export const Header = ({
  translate,
  titleComponent,
}: {
  translate: MotionValue<number>;
  titleComponent: React.ReactNode;
}) => (
  <motion.div style={{ y: translate }} className="mx-auto max-w-5xl text-center">
    {titleComponent}
  </motion.div>
);

export const Card = ({
  rotate,
  scale,
  translate,
  children,
  staticMotion = false,
}: {
  rotate: MotionValue<number>;
  scale: MotionValue<number>;
  translate: MotionValue<number>;
  children: React.ReactNode;
  staticMotion?: boolean;
}) => (
  <motion.div
    data-scroll-card
    style={{
      rotateX: staticMotion ? 0 : rotate,
      scale: staticMotion ? 1 : scale,
      y: staticMotion ? 0 : translate,
      boxShadow:
        "0 0 #0000004d, 0 9px 20px #00000029, 0 37px 37px #00000022, 0 84px 50px #00000012, 0 149px 60px #00000008",
    }}
    className="dashboard-scroll-card relative mx-auto w-full overflow-hidden rounded-[30px] border-4 border-[#6C6C6C] bg-[#222222] p-2 md:p-4"
  >
    <div className="dashboard-scroll-screen h-full w-full overflow-hidden rounded-2xl bg-gray-100">
      {children}
    </div>
  </motion.div>
);
