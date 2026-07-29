import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A draggable edge for one of the shell's two panels.
 *
 * The width is a browser preference, not session state: it says how this person
 * likes their window split, which is true of every session they open and of
 * nothing on the Hub. So it lives in `localStorage` and never travels.
 *
 * The value is handed back as a number and written onto the panel as the same
 * custom property the stylesheet already reads, which is what keeps the phone
 * honest: the drawer and the overlay clamp against the viewport in CSS, so a
 * width dragged wide on a desktop cannot make either of them unusable.
 */
export function useResizable({
  storageKey,
  fallback,
  min,
  max,
  // Which side of the panel the handle sits on. Dragging the right edge of the
  // left panel outward widens it; on the right panel the same gesture is the
  // other direction.
  edge
}: {
  storageKey: string;
  fallback: number;
  min: number;
  max: number;
  edge: 'start' | 'end';
}) {
  const [width, setWidth] = useState(() => read(storageKey, fallback, min, max));
  const drag = useRef<
    { pointerId: number; startX: number; startWidth: number } | undefined
  >(undefined);

  const commit = useCallback(
    (next: number) => {
      const clamped = Math.round(Math.min(max, Math.max(min, next)));
      setWidth(clamped);
      try {
        localStorage.setItem(storageKey, String(clamped));
      } catch {
        // A browser that refuses storage still gets to resize; it just forgets.
      }
      return clamped;
    },
    [storageKey, min, max]
  );

  // The listeners go on the window rather than the handle: a pointer dragged
  // fast leaves a 6px strip behind, and losing the drag there is the difference
  // between a handle that works and one that fights back.
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const active = drag.current;
      if (!active || event.pointerId !== active.pointerId) {
        return;
      }
      const delta = event.clientX - active.startX;
      commit(active.startWidth + (edge === 'end' ? delta : -delta));
    };
    const onEnd = (event: PointerEvent) => {
      if (drag.current?.pointerId !== event.pointerId) {
        return;
      }
      drag.current = undefined;
      document.body.classList.remove('resizing');
    };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onEnd);
    addEventListener('pointercancel', onEnd);
    return () => {
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onEnd);
      removeEventListener('pointercancel', onEnd);
    };
  }, [commit, edge]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      // Only the primary button, and never a two-finger scroll on a trackpad.
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      drag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: width
      };
      // Otherwise the text under the pointer selects itself all the way across
      // the conversation, and the cursor flickers between panels mid-drag.
      document.body.classList.add('resizing');
    },
    [width]
  );

  // A separator is focusable, so the arrow keys have to do the same job. This is
  // the only way to resize without a pointer.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const step = event.shiftKey ? 40 : 8;
      const towardsEnd = event.key === 'ArrowRight';
      if (!towardsEnd && event.key !== 'ArrowLeft') {
        return;
      }
      event.preventDefault();
      const delta = towardsEnd ? step : -step;
      commit(width + (edge === 'end' ? delta : -delta));
    },
    [commit, width, edge]
  );

  return {
    width,
    handleProps: {
      role: 'separator' as const,
      tabIndex: 0,
      'aria-orientation': 'vertical' as const,
      'aria-valuenow': width,
      'aria-valuemin': min,
      'aria-valuemax': max,
      onPointerDown,
      onKeyDown,
      onDoubleClick: () => commit(fallback)
    }
  };
}

function read(key: string, fallback: number, min: number, max: number) {
  try {
    const stored = Number(localStorage.getItem(key));
    if (Number.isFinite(stored) && stored > 0) {
      return Math.round(Math.min(max, Math.max(min, stored)));
    }
  } catch {
    // Storage can be unavailable (private mode, blocked cookies); the default
    // width is a perfectly good answer.
  }
  return fallback;
}
