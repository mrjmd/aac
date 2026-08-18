'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompletionPhoto } from '@/lib/completion';

/**
 * Full-screen slideshow for tech-uploaded photos/videos.
 *
 * The app viewport disables native pinch zoom (userScalable: false), so
 * zooming is implemented here with pointer events:
 *
 *   swipe left/right (scale 1)  — previous / next item
 *   pinch                       — zoom 1x–5x, anchored at the pinch midpoint
 *   drag (scale > 1)            — pan
 *   double-tap / double-click   — toggle 1x <-> 2.5x at the tap point
 *   Escape / ×                  — close (no tap-to-close: it would race
 *                                 the double-tap zoom detection)
 *
 * Transform model: screen = translate + scale * content (origin 0 0).
 */

interface Props {
  photos: CompletionPhoto[];
  startIndex: number;
  onClose: () => void;
}

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const SWIPE_THRESHOLD_PX = 60;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 40;

interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0 };

export default function PhotoLightbox({ photos, startIndex, onClose }: Props) {
  const [index, setIndex] = useState(() => Math.min(Math.max(startIndex, 0), photos.length - 1));
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  // Horizontal swipe offset while dragging at scale 1 (visual feedback only).
  const [swipeDx, setSwipeDx] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  // Live pointer positions by pointerId. Refs (not state): gesture math
  // runs inside move handlers and must never lag a render behind.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    // Pinch anchors
    startDist: number;
    startMid: { x: number; y: number };
    startTransform: Transform;
    // Single-pointer anchors
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);

  const current = photos[index];
  const count = photos.length;

  const goTo = useCallback(
    (next: number) => {
      setIndex(((next % count) + count) % count);
      setTransform(IDENTITY);
      setSwipeDx(0);
    },
    [count],
  );

  // Escape to close; lock body scroll while open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') goTo(index + 1);
      if (e.key === 'ArrowLeft') goTo(index - 1);
    }
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, goTo, index]);

  function clampScale(s: number): number {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  }

  /** Keep the content from drifting fully offscreen when zoomed. */
  function clampTranslate(t: Transform): Transform {
    const el = containerRef.current;
    if (!el || t.scale <= 1) return { scale: t.scale, tx: 0, ty: 0 };
    const { clientWidth: w, clientHeight: h } = el;
    // Content is the container-sized box scaled by t.scale. Allow panning
    // until the far edge reaches the viewport center.
    const minTx = -w * t.scale + w / 2;
    const minTy = -h * t.scale + h / 2;
    return {
      scale: t.scale,
      tx: Math.min(w / 2, Math.max(minTx, t.tx)),
      ty: Math.min(h / 2, Math.max(minTy, t.ty)),
    };
  }

  /** Rescale around a fixed screen point M: t' = M - (s'/s)(M - t). */
  function zoomAt(prev: Transform, nextScale: number, mx: number, my: number): Transform {
    const s = clampScale(nextScale);
    const ratio = s / prev.scale;
    return clampTranslate({
      scale: s,
      tx: mx - ratio * (mx - prev.tx),
      ty: my - ratio * (my - prev.ty),
    });
  }

  function localPoint(e: React.PointerEvent): { x: number; y: number } {
    const rect = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (current.kind === 'video') return; // video uses native controls
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = localPoint(e);
    pointers.current.set(e.pointerId, p);
    const pts = [...pointers.current.values()];
    if (pts.length === 2) {
      const [a, b] = pts;
      gesture.current = {
        startDist: Math.hypot(a.x - b.x, a.y - b.y),
        startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        startTransform: transform,
        startX: 0,
        startY: 0,
        moved: true, // a pinch is never a tap
      };
      setSwipeDx(0);
    } else if (pts.length === 1) {
      gesture.current = {
        startDist: 0,
        startMid: p,
        startTransform: transform,
        startX: p.x,
        startY: p.y,
        moved: false,
      };
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    const p = localPoint(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    const pts = [...pointers.current.values()];

    if (pts.length >= 2) {
      const [a, b] = pts;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (g.startDist > 0) {
        const raw = g.startTransform.scale * (dist / g.startDist);
        setTransform(zoomAt(g.startTransform, raw, g.startMid.x, g.startMid.y));
      }
      return;
    }

    const dx = p.x - g.startX;
    const dy = p.y - g.startY;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) g.moved = true;

    if (g.startTransform.scale > 1) {
      setTransform(
        clampTranslate({
          scale: g.startTransform.scale,
          tx: g.startTransform.tx + dx,
          ty: g.startTransform.ty + dy,
        }),
      );
    } else {
      setSwipeDx(dx);
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);

    if (pointers.current.size === 1) {
      // Pinch ended with one finger still down: restart as a pan/swipe from here.
      const remaining = [...pointers.current.values()][0];
      gesture.current = {
        startDist: 0,
        startMid: remaining,
        startTransform: transform,
        startX: remaining.x,
        startY: remaining.y,
        moved: true,
      };
      return;
    }
    if (pointers.current.size > 0) return;
    if (!g) return;
    gesture.current = null;

    // Swipe navigation (only from unzoomed state).
    if (g.startTransform.scale === 1 && g.startDist === 0) {
      if (swipeDx <= -SWIPE_THRESHOLD_PX) { goTo(index + 1); return; }
      if (swipeDx >= SWIPE_THRESHOLD_PX) { goTo(index - 1); return; }
    }
    setSwipeDx(0);

    // Double-tap zoom toggle.
    if (!g.moved && g.startDist === 0) {
      const now = Date.now();
      const p = { x: g.startX, y: g.startY };
      const last = lastTap.current;
      if (
        last &&
        now - last.at < DOUBLE_TAP_MS &&
        Math.hypot(p.x - last.x, p.y - last.y) < DOUBLE_TAP_SLOP_PX
      ) {
        lastTap.current = null;
        setTransform((t) =>
          t.scale > 1 ? IDENTITY : zoomAt(t, DOUBLE_TAP_SCALE, p.x, p.y),
        );
      } else {
        lastTap.current = { at: now, ...p };
      }
    }
  }

  function onPointerCancel(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = null;
      setSwipeDx(0);
    }
  }

  const zoomed = transform.scale > 1;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/95"
      role="dialog"
      aria-modal="true"
      aria-label="Photo viewer"
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <span className="text-sm tabular-nums">
          {index + 1} / {count}
          <span className="ml-2 rounded bg-white/15 px-1.5 py-0.5 text-[11px] uppercase tracking-wide">
            {current.label}
          </span>
        </span>
        <div className="flex items-center gap-4">
          <a
            href={current.url}
            target="_blank"
            rel="noreferrer"
            className="text-xs underline underline-offset-2 text-white/80"
          >
            Open original
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-xl leading-none"
          >
            ×
          </button>
        </div>
      </div>

      {/* Stage */}
      <div
        ref={containerRef}
        className="relative flex-1 overflow-hidden"
        style={{ touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            transform: zoomed
              ? `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`
              : `translate(${swipeDx}px, 0)`,
            transformOrigin: '0 0',
            transition: gesture.current ? 'none' : 'transform 150ms ease-out',
          }}
        >
          {current.kind === 'video' ? (
            <video
              key={current.url}
              src={current.url}
              controls
              playsInline
              className="max-h-full max-w-full"
            />
          ) : (
            <img
              key={current.url}
              src={current.url}
              alt={current.label}
              draggable={false}
              className="max-h-full max-w-full select-none object-contain"
            />
          )}
        </div>

        {/* Prev/next — hidden while zoomed (drag pans instead) */}
        {count > 1 && !zoomed && (
          <>
            <button
              type="button"
              onClick={() => goTo(index - 1)}
              aria-label="Previous photo"
              className="absolute left-2 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-2xl text-white"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => goTo(index + 1)}
              aria-label="Next photo"
              className="absolute right-2 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-2xl text-white"
            >
              ›
            </button>
          </>
        )}
      </div>

      {/* Dot strip */}
      {count > 1 && (
        <div className="flex items-center justify-center gap-1.5 pb-4 pt-2">
          {photos.map((p, i) => (
            <button
              key={p.url}
              type="button"
              onClick={() => goTo(i)}
              aria-label={`Photo ${i + 1}`}
              className={`h-2 rounded-full transition-all ${
                i === index ? 'w-5 bg-white' : 'w-2 bg-white/40'
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
