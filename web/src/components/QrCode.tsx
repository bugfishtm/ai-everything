import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/**
 * A QR code as an SVG — dark squares on white whatever the theme (phone cameras need the contrast),
 * with the quiet zone around it that scanners expect.
 */
export function QrCode({ value, size = 200, label }: { value: string; size?: number; label: string }) {
  const { count, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
    return { count: n, path: d };
  }, [value]);
  const box = count + 8;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${box} ${box}`}
      shapeRendering="crispEdges"
      style={{ display: 'block', borderRadius: 8, background: '#fff' }}
    >
      <rect width={box} height={box} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
