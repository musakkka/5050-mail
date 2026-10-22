/** Letter avatar (01-tokens §2.2): deterministic colour from the lowercase email. */
const PALETTE = ['#1A73E8', '#D93025', '#188038', '#E37400', '#9334E6', '#C5221F', '#12B5CB', '#E8710A', '#1E8E3E', '#A142F4', '#F439A0', '#5F6368'];

export function avatarColor(key: string): string {
  let h = 0;
  for (const ch of key.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function initialOf(name: string | null | undefined, email: string): string {
  const s = (name?.trim() || email).replace(/^["'(]+/, '');
  const ch = [...s][0] ?? '?';
  return ch.toUpperCase();
}

export function Avatar({ name, email, size = 40, className }: { name?: string | null; email: string; size?: number; className?: string }) {
  return (
    <span
      className={`avatar${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size, fontSize: size / 2, background: avatarColor(email || name || '?') }}
      aria-hidden="true"
    >
      {initialOf(name, email)}
    </span>
  );
}
