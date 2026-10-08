"use client";

import React, { useEffect, useRef, useState } from "react";
import { motion, useMotionValueEvent, useReducedMotion, useScroll, useTransform } from "framer-motion";
import type { MotionValue } from "framer-motion";

/**
 * Aceternity ContainerScroll — paramètres d'origine :
 * useScroll({ target }), rotateX 20° → 0°, zoom desktop 1.05 → 1,
 * zoom mobile 0.7 → 0.9, titre 0 → -100 px.
 *
 * La structure éditoriale Taply demeure en HTML hors de l'îlot React ;
 * le mouvement du titre est transmis par une variable CSS pour ne pas le dupliquer.
 */
export const ContainerScroll = ({
  titleComponent,
  children,
}: {
  titleComponent: string | React.ReactNode;
  children: React.ReactNode;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: containerRef });
  const [isMobile, setIsMobile] = useState(false);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Ces trois transformations sont les valeurs de la référence fournie.
  const rotate = useTransform(scrollYProgress, [0, 1], [20, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], isMobile ? [0.7, 0.9] : [1.05, 1]);
  const translate = useTransform(scrollYProgress, [0, 1], [0, -100]);

  const titleTarget = () =>
    containerRef.current?.closest("[data-dashboard-story]")?.querySelector<HTMLElement>(".dashboard-story__intro-motion");

  useMotionValueEvent(translate, "change", (y) => {
    titleTarget()?.style.setProperty("--dashboard-title-y", reducedMotion || isMobile ? "0px" : `${y.toFixed(2)}px`);
  });

  useEffect(() => {
    titleTarget()?.style.setProperty("--dashboard-title-y", reducedMotion || isMobile ? "0px" : `${translate.get().toFixed(2)}px`);
    return () => { titleTarget()?.style.removeProperty("--dashboard-title-y"); };
  }, [reducedMotion, isMobile, translate]);

  return (
    <div className="dashboard-scroll-container relative flex w-full items-center justify-center" ref={containerRef}>
      <div className="dashboard-scroll-perspective relative w-full" style={{ perspective: "1000px" }}>
        {titleComponent ? <Header translate={translate} titleComponent={titleComponent} /> : null}
        <Card rotate={rotate} scale={scale} staticMotion={Boolean(reducedMotion) || isMobile}>
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
  children,
  staticMotion = false,
}: {
  rotate: MotionValue<number>;
  scale: MotionValue<number>;
  children: React.ReactNode;
  staticMotion?: boolean;
}) => (
  <motion.div
    data-scroll-card
    style={{
      rotateX: staticMotion ? 0 : rotate,
      scale: staticMotion ? 1 : scale,
      boxShadow:
        "0 0 #0000004d, 0 9px 20px #0000004a, 0 37px 37px #00000042, 0 84px 50px #00000026, 0 149px 60px #0000000a, 0 233px 65px #00000003",
    }}
    className="dashboard-scroll-card relative mx-auto w-full overflow-hidden rounded-[30px] border-4 border-[#6C6C6C] bg-[#222222] p-2 md:p-6"
  >
    <div className="dashboard-scroll-screen h-full w-full overflow-hidden rounded-2xl bg-gray-100">
      {children}
    </div>
  </motion.div>
);
