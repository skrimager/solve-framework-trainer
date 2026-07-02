import { useEffect, useState } from "react";

/**
 * Tracks the browser's visual viewport height in pixels, updating live as the
 * on-screen keyboard opens/closes on mobile. `100dvh` alone is unreliable for this —
 * many mobile browsers (notably iOS Safari) don't shrink `dvh` when the keyboard
 * appears, so a fixed-height chat layout gets pushed off-screen and covered by the
 * keyboard instead of resizing around it. Listening to `window.visualViewport`
 * directly gives the real usable height so the layout can respond correctly.
 *
 * Falls back to `window.innerHeight` in environments without `visualViewport` support.
 */
export function useViewportHeight() {
  const [height, setHeight] = useState<number>(() =>
    typeof window !== "undefined" ? window.visualViewport?.height ?? window.innerHeight : 0
  );

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) {
      const onResize = () => setHeight(window.innerHeight);
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }

    const update = () => setHeight(vv.height);
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return height;
}
