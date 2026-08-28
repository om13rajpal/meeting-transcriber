'use client';

import { useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(useGSAP, ScrollTrigger);

// Marketing-only motion. GSAP never ships to Dashboard.js or MeetingDetail.js,
// both of which are already the heaviest client bundles in the app; product
// surfaces use plain CSS transitions instead. See the implementation spec's
// GSAP appendix.
export default function LandingMotion({ children }) {
  const root = useRef(null);

  useGSAP(() => {
    // Reduced motion is read here, not only in CSS, because GSAP writes
    // inline styles that a media query alone cannot override.
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const y = reduce ? 0 : 18;

    gsap.timeline({ defaults: { ease: 'power3.out', duration: reduce ? 0.2 : 0.7 } })
      .from('.cr-eyebrow', { y, opacity: 0 })
      .from('.cr-hero-char', { y, opacity: 0, stagger: reduce ? 0 : 0.025 }, '-=0.45')
      .from('.cr-lede', { y, opacity: 0 }, '-=0.45')
      .from('.cr-cta-row', { y, opacity: 0 }, '-=0.40')
      .from('.cr-transcript-card', { y, opacity: 0, duration: reduce ? 0.2 : 0.8 }, '-=0.55');

    gsap.set('.cr-reveal', { y: reduce ? 0 : 20, autoAlpha: 0 });
    ScrollTrigger.batch('.cr-reveal', {
      start: 'top 88%',
      once: true,
      onEnter: (batch) => gsap.to(batch, {
        autoAlpha: 1,
        y: 0,
        duration: reduce ? 0.2 : 0.6,
        ease: 'power3.out',
        stagger: reduce ? 0 : 0.06
      })
    });

    // A real scroll-scrubbed effect (progress tied directly to scroll
    // position, not a one-shot reveal): the hero transcript card drifts up
    // slightly slower than the page as the hero section scrolls past,
    // classic parallax. Skipped under reduced motion, since scrub-driven
    // translation is exactly the kind of movement that rule removes.
    if (!reduce) {
      gsap.to('.cr-transcript-card', {
        y: -36,
        ease: 'none',
        scrollTrigger: {
          trigger: '.cr-hero-section',
          start: 'top top',
          end: 'bottom top',
          scrub: 0.6
        }
      });
    }

    // The hand-off ribbon draw. See components/brand/HandoffRibbon.jsx, the
    // wrapper groups around each hand/cargo group are the fix for a real
    // GSAP bug (tweening x on a group that already carries transform="
    // translate(...)" snaps it, since GSAP parses that as its baseline).
    const path = root.current?.querySelector('.cr-ribbon-path');
    if (path) {
      if (reduce) {
        gsap.set(['.cr-hand-a', '.cr-hand-b', '.cr-cargo-in', '.cr-cargo-out'], { opacity: 1 });
      } else {
        const len = path.getTotalLength();
        gsap.set(path, { strokeDasharray: len, strokeDashoffset: len });
        gsap.set('.cr-hand-a', { opacity: 0, x: -20 });
        gsap.set('.cr-hand-b', { opacity: 0, x: 20 });
        gsap.set('.cr-cargo-in', { opacity: 0, scale: 0.9, transformOrigin: 'center' });
        gsap.set('.cr-cargo-out', { opacity: 0 });

        ScrollTrigger.batch('.cr-ribbon-wrap', {
          start: 'top 75%',
          once: true,
          onEnter: () => {
            gsap.timeline({ defaults: { ease: 'power3.out' } })
              .to(path, { strokeDashoffset: 0, duration: 0.98, ease: 'power4.inOut' })
              .to('.cr-hand-a', { x: 0, opacity: 1, duration: 0.6 }, '<')
              .to('.cr-cargo-in', { scale: 1, opacity: 1, duration: 0.4 }, '-=0.2')
              .to('.cr-hand-b', { x: 0, opacity: 1, duration: 0.6 }, '-=0.3')
              .to('.cr-cargo-out', { opacity: 1, duration: 0.4 }, '-=0.2');
          }
        });
      }
    }

    // A reveal is an enhancement, and an enhancement is never allowed to be
    // the reason content is unreadable. Anything still invisible once it is
    // plausibly on screen gets shown, no animation, no questions.
    const safety = window.setTimeout(() => {
      // .cr-reveal was hidden with autoAlpha (opacity + visibility:hidden),
      // so it must be restored with autoAlpha too. A plain opacity:1 here
      // would leave visibility:hidden in place and the element would stay
      // invisible despite "succeeding".
      root.current?.querySelectorAll('.cr-reveal').forEach((el) => {
        if (window.getComputedStyle(el).opacity === '0') gsap.set(el, { autoAlpha: 1, y: 0 });
      });
      root.current?.querySelectorAll('.cr-hand-a, .cr-hand-b, .cr-cargo-in, .cr-cargo-out').forEach((el) => {
        if (window.getComputedStyle(el).opacity === '0') gsap.set(el, { opacity: 1, x: 0, scale: 1 });
      });
    }, 2500);

    // Big Shoulders is a condensed display face and reflows the page
    // measurably once it lands, so ScrollTrigger has to re-measure or the
    // batch triggers sit in the wrong place on a cold load.
    document.fonts?.ready.then(() => ScrollTrigger.refresh());

    return () => window.clearTimeout(safety);
  }, { scope: root });

  return <div ref={root}>{children}</div>;
}
