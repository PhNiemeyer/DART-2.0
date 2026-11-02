'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * Gezeichnete Unterschrift (DEMONSTRATION). Erfasst nur das Bild, keine biometrischen Dynamikdaten
 * (keine Zeitstempel, kein Druck). Barrierefreie Alternative: getippter Name.
 */
export function SignaturePad({ onChange }: { onChange: (pngDataUrl: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);
  useEffect(() => {
    const c = ref.current!;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio;
    c.height = c.clientHeight * ratio;
    const ctx = c.getContext('2d')!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#183247';
  }, []);
  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  return (
    <div>
      <canvas
        ref={ref}
        className="signature-pad"
        aria-label="Unterschriftsfeld (mit Finger, Stift oder Maus). Alternative: Name eintippen."
        role="img"
        onPointerDown={(e) => {
          drawing.current = true;
          const ctx = ref.current!.getContext('2d')!;
          const p = pos(e);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ref.current!.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = ref.current!.getContext('2d')!;
          const p = pos(e);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }}
        onPointerUp={() => {
          drawing.current = false;
          setEmpty(false);
          onChange(ref.current!.toDataURL('image/png'));
        }}
      />
      <button type="button" className="btn-ghost btn-small" style={{ marginTop: 6 }} disabled={empty} onClick={() => {
        const c = ref.current!;
        c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
        setEmpty(true);
        onChange(null);
      }}>Unterschrift löschen</button>
    </div>
  );
}
