'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  prevHref: string;
  nextHref: string;
}

const MIN_SWIPE_DISTANCE = 60;       // px — minimum horizontal travel
const MAX_OFF_AXIS_RATIO = 0.6;      // |dy| / |dx| must be below this

export default function SwipeDayNavigator({ prevHref, nextHref }: Props) {
  const router = useRouter();

  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let active = false;

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      active = true;
    }

    function onTouchEnd(e: TouchEvent) {
      if (!active) return;
      active = false;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dx) < MIN_SWIPE_DISTANCE) return;
      if (Math.abs(dy) / Math.abs(dx) > MAX_OFF_AXIS_RATIO) return;
      if (dx < 0) {
        router.push(nextHref);
      } else {
        router.push(prevHref);
      }
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [router, prevHref, nextHref]);

  return null;
}
