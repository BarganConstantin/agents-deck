// A one-off burst, for the one moment in this app that deserves one.
//
// Adding an account is rare — a handful of times in a deck's life — which is
// the only reason a celebration is defensible here at all. Anything a user sees
// dozens of times a day gets no animation; this they see almost never, and it
// is the moment a live credential finished moving between two machines, where
// "did that work?" is a real question.
//
// Rendered through a portal at fixed coordinates rather than inside the dialog.
// The first version lived in the dialog body and was invisible: .modal has
// overflow: hidden and .modal-body has overflow: auto, so every particle that
// left the text column was clipped — and the ones that did not were about to
// give the body a scrollbar. Escaping the stacking context is not a flourish
// here, it is the only way the effect exists at all.
//
// Deliberately small: no canvas, no library, no dependency. Particles are spans
// carrying their own vector in CSS custom properties, animated with transform
// and opacity only — both GPU properties — then unmounted when the burst ends
// so nothing is left running behind a dialog.
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type Props = {
  /** What to burst from — usually the success mark, which is an SVG. */
  anchor: React.RefObject<Element | null>;
  /** Milliseconds before the whole thing removes itself. */
  lifetimeMs?: number;
};

const COUNT = 18;
const LIFETIME_MS = 1100;

// Fixed, not random: the same burst every time is the same product every time,
// and a seeded shape can be tuned. Angles fan upward and outward; the widest
// are deliberately shorter so the silhouette is a spray, not a circle.
// A deterministic 0…1 from an index. Not Math.random: the same burst every
// time is the same product every time, and a fixed one can be tuned by eye.
const jitter = (i: number, salt: number) => {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

const PARTICLES = Array.from({ length: COUNT }, (_, i) => {
  // Even angles with a nudge, uneven reach, uneven speed. Perfectly regular
  // values produce a perfect arc — measured: a frozen frame of the first
  // version was a clean halo around the mark, which reads as a loading ring
  // rather than as something thrown.
  const spread = -72 + (144 * i) / (COUNT - 1) + (jitter(i, 1) - 0.5) * 9;
  const rad = (spread - 90) * (Math.PI / 180);           // 0° = straight up
  const reach = (54 + 32 * Math.cos((spread * Math.PI) / 180)) * (0.74 + jitter(i, 2) * 0.52);
  return {
    dx: Math.cos(rad) * reach,
    dy: Math.sin(rad) * reach,
    rot: (i % 2 ? 1 : -1) * (100 + jitter(i, 3) * 260),
    delay: Math.round(jitter(i, 4) * 90),                // 0–90ms, a loose stagger
    dur: 760 + Math.round(jitter(i, 5) * 260),           // so they do not land together
    scale: 0.8 + jitter(i, 6) * 0.45,
    hue: i % 4,                                          // maps to a token in CSS
    round: i % 3 === 0,
  };
});

export default function Confetti({ anchor, lifetimeMs = LIFETIME_MS }: Props) {
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);

  // Motion sickness is a real cost and a burst is pure decoration, so a reduced
  // -motion preference removes it entirely rather than slowing it down.
  const reduced = typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (reduced) return;
    const el = anchor.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setOrigin({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    const t = window.setTimeout(() => setOrigin(null), lifetimeMs);
    return () => window.clearTimeout(t);
  }, [anchor, lifetimeMs, reduced]);

  if (reduced || !origin) return null;

  return createPortal(
    <div className="confetti" style={{ left: `${origin.x}px`, top: `${origin.y}px` }} aria-hidden>
      {PARTICLES.map((p, i) => (
        <span
          key={i}
          className={`confetti-bit${p.round ? " round" : ""}`}
          data-hue={p.hue}
          style={{
            // Custom properties rather than inline transforms: the keyframes own
            // the motion, this only says where each piece is going.
            ["--dx" as string]: `${p.dx.toFixed(1)}px`,
            ["--dy" as string]: `${p.dy.toFixed(1)}px`,
            ["--rot" as string]: `${p.rot}deg`,
            ["--s" as string]: p.scale.toFixed(2),
            animationDelay: `${p.delay}ms`,
            animationDuration: `${p.dur}ms, ${p.dur}ms`,
          }}
        />
      ))}
    </div>,
    document.body,
  );
}
