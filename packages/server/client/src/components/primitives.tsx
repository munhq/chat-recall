// Chat Recall — UI kit primitives (v2, premium rebuild)
// Self-contained; uses tokens from index.css.
import React, { useState } from 'react';

// ────────────────────────────── Icon ──────────────────────────────
const ICONS: Record<string, string> = {
  search: 'M21 21l-4.35-4.35M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15z',
  x: 'M18 6L6 18M6 6l12 12',
  plus: 'M12 5v14M5 12h14',
  chevronRight: 'M9 18l6-6-6-6',
  chevronLeft:  'M15 18l-6-6 6-6',
  chevronDown:  'M6 9l6 6 6-6',
  arrowUp: 'M12 19V5M5 12l7-7 7 7',
  arrowDown: 'M12 5v14M19 12l-7 7-7-7',
  refresh: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5',
  filter: 'M22 3H2l8 9.46V19l4 2v-8.54L22 3z',
  clock: 'M12 6v6l4 2M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v11z',
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10z',
  brain: 'M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2zM14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2z',
  chart: 'M3 3v18h18M7 16l4-8 4 4 4-6',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  sparkle: 'M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3zM19 14l.75 2.25L22 17l-2.25.75L19 20l-.75-2.25L16 17l2.25-.75L19 14z',
  zap: 'M13 2L3 14h8l-1 8 10-12h-8l1-8z',
  check: 'M20 6L9 17l-5-5',
  arrowRight: 'M5 12h14M12 5l7 7-7 7',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  terminal: 'M4 17l6-6-6-6M12 19h8',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  tag: 'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01',
  database: 'M12 8c4.97 0 9-1.57 9-3.5S16.97 1 12 1 3 2.57 3 4.5 7.03 8 12 8zM3 4.5v15C3 21.43 7.03 23 12 23s9-1.57 9-3.5v-15M3 12c0 1.93 4.03 3.5 9 3.5s9-1.57 9-3.5',
  sun: 'M12 3v2M12 19v2M5.64 5.64l1.41 1.41M16.95 16.95l1.41 1.41M3 12h2M19 12h2M5.64 18.36l1.41-1.41M16.95 7.05l1.41-1.41M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  menu: 'M3 6h18M3 12h18M3 18h18',
};

interface IconProps extends React.SVGProps<SVGSVGElement> {
  name: string;
  size?: number;
  strokeWidth?: number;
}

export function Icon({ name, size = 16, strokeWidth = 1.75, style, ...rest }: IconProps) {
  const d = ICONS[name];
  if (!d) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
      {...rest}
    >
      <path d={d} />
    </svg>
  );
}

// ────────────────────────────── Kbd ──────────────────────────────
interface KbdProps {
  children: React.ReactNode;
  style?: React.CSSProperties;
}

export function Kbd({ children, style }: KbdProps) {
  return (
    <kbd
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 20,
        padding: '0 6px',
        background: 'var(--cr-ink-2)',
        border: '1px solid var(--cr-line-1)',
        borderBottomWidth: 2,
        borderRadius: 4,
        fontFamily: 'var(--cr-font-mono)',
        fontSize: 11,
        fontWeight: 500,
        color: 'var(--cr-fg-3)',
        letterSpacing: 0,
        ...style,
      }}
    >
      {children}
    </kbd>
  );
}

// ────────────────────────────── Chip / Badge ──────────────────────────────
interface ChipProps {
  children: React.ReactNode;
  kind?: 'neutral' | 'mono' | 'brand' | 'ok' | 'warn' | 'err' | 'info';
  icon?: string;
  size?: 'sm' | 'md';
  style?: React.CSSProperties;
  className?: string;
}

export function Chip({ children, kind = 'neutral', icon, size = 'md', style, className }: ChipProps) {
  const sizes: Record<string, { h: number, px: number, fs: number }> = {
    xs: { h: 18, px: 4, fs: 9 },
    sm: { h: 20, px: 6, fs: 11 },
    md: { h: 22, px: 8, fs: 12 },
  };
  const s = sizes[size] || sizes.md;
  const kinds: Record<string, { bg: string; fg: string; border: string; font?: string }> = {
    neutral: { bg: 'var(--cr-ink-2)', fg: 'var(--cr-fg-2)', border: 'var(--cr-line-1)' },
    mono: { bg: 'var(--cr-ink-2)', fg: 'var(--cr-fg-2)', border: 'var(--cr-line-1)', font: 'var(--cr-font-mono)' },
    brand: { bg: 'var(--cr-brand-surf)', fg: 'var(--cr-brand-500)', border: 'var(--cr-brand-line)' },
    ok: { bg: 'var(--cr-ok-surf)', fg: 'var(--cr-ok-500)', border: 'var(--cr-ok-line)' },
    warn: { bg: 'var(--cr-warn-surf)', fg: 'var(--cr-warn-500)', border: 'var(--cr-warn-line)' },
    err: { bg: 'var(--cr-err-surf)', fg: 'var(--cr-err-500)', border: 'var(--cr-err-line)' },
    info: { bg: 'var(--cr-info-surf)', fg: 'var(--cr-info-500)', border: 'var(--cr-info-line)' },
  };
  const k = kinds[kind];
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: s.h,
        padding: `0 ${s.px}px`,
        background: k.bg,
        color: k.fg,
        border: `1px solid ${k.border}`,
        borderRadius: 'var(--cr-radius-xs)',
        fontFamily: k.font || 'inherit',
        fontSize: s.fs,
        fontWeight: 500,
        letterSpacing: 0,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {icon && <Icon name={icon} size={s.fs} />}
      {children}
    </span>
  );
}

// ────────────────────────────── ToolBadge ──────────────────────────────
interface ToolBadgeProps {
  tool: string;
  size?: 'sm' | 'md';
}

export function ToolBadge({ tool, size = 'md' }: ToolBadgeProps) {
  const m: Record<string, { fg: string; surf: string; label: string }> = {
    claude: { fg: 'var(--cr-tool-claude)', surf: 'var(--cr-tool-claude-surf)', label: 'Claude' },
    gemini: { fg: 'var(--cr-tool-gemini)', surf: 'var(--cr-tool-gemini-surf)', label: 'Gemini' },
    opencode: { fg: 'var(--cr-tool-opencode)', surf: 'var(--cr-tool-opencode-surf)', label: 'OpenCode' },
    codex: { fg: 'var(--cr-tool-codex)', surf: 'var(--cr-tool-codex-surf)', label: 'Codex' },
  };
  const info = m[tool];
  if (!info) return null;
  const s = size === 'sm' ? { h: 18, px: 6, fs: 10, dot: 5 } : { h: 22, px: 8, fs: 11, dot: 6 };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: s.h,
        padding: `0 ${s.px}px`,
        background: info.surf,
        color: info.fg,
        border: `1px solid ${info.fg}40`,
        borderRadius: 'var(--cr-radius-xs)',
        fontSize: s.fs,
        fontWeight: 500,
        letterSpacing: 0,
      }}
    >
      <span style={{ width: s.dot, height: s.dot, borderRadius: '50%', background: info.fg }} />
      {info.label}
    </span>
  );
}

// ────────────────────────────── SourceBadge ──────────────────────────────
interface SourceBadgeProps {
  source: string;
  size?: 'sm' | 'md';
}

export function SourceBadge({ source, size = 'md' }: SourceBadgeProps) {
  const m: Record<string, { icon: string; label: string; color: string }> = {
    session: { icon: 'message', label: 'Session', color: 'var(--cr-info-500)' },
    plan: { icon: 'check', label: 'Plan', color: 'var(--cr-ok-500)' },
    task: { icon: 'zap', label: 'Task', color: 'var(--cr-warn-500)' },
    claude_md: { icon: 'file', label: 'CLAUDE.md', color: 'var(--cr-brand-500)' },
    history: { icon: 'terminal', label: 'History', color: 'var(--cr-tool-opencode)' },
    paste: { icon: 'tag', label: 'Paste', color: 'var(--cr-fg-2)' },
    diary: { icon: 'book', label: 'Diary', color: 'var(--cr-info-500)' },
  };
  const info = m[source];
  if (!info) return null;
  const s = size === 'sm' ? { h: 20, px: 6, fs: 11 } : { h: 22, px: 8, fs: 12 };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: s.h,
        padding: `0 ${s.px}px`,
        background: 'var(--cr-ink-2)',
        border: '1px solid var(--cr-line-1)',
        borderRadius: 'var(--cr-radius-xs)',
        color: info.color,
        fontSize: s.fs,
        fontWeight: 500,
      }}
    >
      <Icon name={info.icon} size={s.fs - 1} />
      <span style={{ color: 'var(--cr-fg-1)' }}>{info.label}</span>
    </span>
  );
}

// ────────────────────────────── Avatar (project monogram) ──────────────────────────────
interface AvatarProps {
  name: string;
  size?: number;
}

export function Avatar({ name, size = 28 }: AvatarProps) {
  const initials = (name || '?')
    .split(/[\s\-\/_]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0].toUpperCase())
    .join('');
  const hues = [18, 200, 150, 280, 35, 330];
  const hue = hues[(name || '').length % hues.length];
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.22),
        background: `hsl(${hue} 35% 22%)`,
        color: `hsl(${hue} 70% 75%)`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.round(size * 0.4),
        fontWeight: 600,
        letterSpacing: '-0.02em',
        border: '1px solid rgba(255,255,255,0.04)',
        flexShrink: 0,
      }}
    >
      {initials}
    </div>
  );
}

// ────────────────────────────── Logo ──────────────────────────────
interface LogoProps {
  size?: number;
}

export function Logo({ size = 24 }: LogoProps) {
  return (
    <div
      style={{
        width: size,
        height: size,
        background: 'var(--cr-ink-2)',
        border: '1px solid var(--cr-line-1)',
        borderRadius: Math.round(size * 0.26),
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        position: 'relative',
      }}
    >
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 16 16" fill="none">
        <path
          d="M13 5.5C13 5.22 12.78 5 12.5 5h-9C3.22 5 3 5.22 3 5.5v6c0 .28.22.5.5.5H5v2l2.5-2H12.5c.28 0 .5-.22.5-.5v-6z"
          fill="var(--cr-brand-500)"
        />
      </svg>
    </div>
  );
}

// ────────────────────────────── Button ──────────────────────────────
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: string;
  iconRight?: string;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  disabled,
  children,
  onClick,
  style,
  ...rest
}: ButtonProps) {
  const [hov, setHov] = useState(false);
  const [active, setActive] = useState(false);

  const sizes = {
    sm: { h: 28, px: 10, fs: 13, gap: 6, iconSize: 14 },
    md: { h: 34, px: 12, fs: 13, gap: 7, iconSize: 15 },
    lg: { h: 40, px: 16, fs: 14, gap: 8, iconSize: 16 },
  };
  const s = sizes[size];

  const palettes: Record<string, { bg: string; bgHov: string; bgAct: string; fg: string; border: string; shadow: string }> = {
    primary: {
      bg: 'var(--cr-brand-500)',
      bgHov: 'var(--cr-brand-600)',
      bgAct: 'var(--cr-brand-700)',
      fg: '#1A0E06',
      border: 'transparent',
      shadow: '0 1px 2px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.06) inset',
    },
    secondary: {
      bg: 'var(--cr-ink-2)',
      bgHov: 'var(--cr-ink-3)',
      bgAct: 'var(--cr-ink-4)',
      fg: 'var(--cr-fg-1)',
      border: 'var(--cr-line-2)',
      shadow: '0 0 0 1px rgba(255,255,255,0.02) inset',
    },
    ghost: {
      bg: 'transparent',
      bgHov: 'var(--cr-ink-2)',
      bgAct: 'var(--cr-ink-3)',
      fg: 'var(--cr-fg-2)',
      border: 'transparent',
      shadow: 'none',
    },
    outline: {
      bg: 'transparent',
      bgHov: 'var(--cr-ink-2)',
      bgAct: 'var(--cr-ink-3)',
      fg: 'var(--cr-fg-1)',
      border: 'var(--cr-line-2)',
      shadow: 'none',
    },
    danger: {
      bg: 'var(--cr-err-500)',
      bgHov: '#D55862',
      bgAct: '#C14852',
      fg: '#1A0709',
      border: 'transparent',
      shadow: '0 1px 2px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.06) inset',
    },
  };
  const p = palettes[variant];
  const bg = disabled ? p.bg : active ? p.bgAct : hov ? p.bgHov : p.bg;

  return (
    <button
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => {
        setHov(false);
        setActive(false);
      }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      style={{
        height: s.h,
        padding: `0 ${s.px}px`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: s.gap,
        background: bg,
        color: p.fg,
        border: `1px solid ${p.border}`,
        borderRadius: 'var(--cr-radius-sm)',
        fontFamily: 'inherit',
        fontSize: s.fs,
        fontWeight: 'var(--cr-fw-medium)',
        letterSpacing: '-0.005em',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background var(--cr-dur-fast) var(--cr-ease), border-color var(--cr-dur-fast) var(--cr-ease)',
        boxShadow: p.shadow,
        whiteSpace: 'nowrap',
        ...style,
      }}
      {...rest}
    >
      {icon && <Icon name={icon} size={s.iconSize} />}
      {children}
      {iconRight && <Icon name={iconRight} size={s.iconSize} />}
    </button>
  );
}

// ────────────────────────────── IconButton ──────────────────────────────
interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: string;
  size?: number;
}

export function IconButton({ icon, size = 34, onClick, style, title, ...rest }: IconButtonProps) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: hov ? 'var(--cr-ink-2)' : 'transparent',
        color: hov ? 'var(--cr-fg-1)' : 'var(--cr-fg-2)',
        border: 'none',
        borderRadius: 'var(--cr-radius-sm)',
        cursor: 'pointer',
        transition: 'background var(--cr-dur-fast), color var(--cr-dur-fast)',
        ...style,
      }}
      {...rest}
    >
      <Icon name={icon} size={size * 0.47} />
    </button>
  );
}

// ────────────────────────────── SegmentedControl ──────────────────────────────
interface SegmentedControlProps {
  options: Array<{ value: string; label: string; icon?: string }>;
  value: string;
  onChange: (v: string) => void;
  size?: 'sm' | 'md';
}

export function SegmentedControl({ options, value, onChange, size = 'md' }: SegmentedControlProps) {
  const h = size === 'sm' ? 28 : 32;
  return (
    <div
      style={{
        display: 'inline-flex',
        padding: 3,
        background: 'var(--cr-ink-2)',
        border: '1px solid var(--cr-line-1)',
        borderRadius: 'var(--cr-radius-sm)',
        gap: 2,
        height: h,
        boxSizing: 'border-box',
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            style={{
              padding: '0 12px',
              background: on ? 'var(--cr-ink-4)' : 'transparent',
              color: on ? 'var(--cr-fg-1)' : 'var(--cr-fg-2)',
              border: 'none',
              borderRadius: 4,
              fontFamily: 'inherit',
              fontSize: 13,
              fontWeight: on ? 500 : 400,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              transition: 'background var(--cr-dur-fast), color var(--cr-dur-fast)',
              boxShadow: on ? '0 1px 2px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.03) inset' : 'none',
            }}
          >
            {o.icon && <Icon name={o.icon} size={13} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ────────────────────────────── Input ──────────────────────────────
interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  icon?: string;
  onClear?: () => void;
  kbd?: string;
  inputSize?: 'sm' | 'md' | 'lg';
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ value, onChange, placeholder, icon = 'search', onClear, kbd, inputSize = 'md', style, ...rest }, ref) => {
    const [focused, setFocused] = useState(false);
    const h = inputSize === 'sm' ? 32 : inputSize === 'lg' ? 44 : 36;

    return (
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          height: h,
          background: 'var(--cr-ink-1)',
          border: `1px solid ${focused ? 'var(--cr-line-3)' : 'var(--cr-line-1)'}`,
          borderRadius: 'var(--cr-radius-sm)',
          transition: 'border-color var(--cr-dur-fast), box-shadow var(--cr-dur-fast)',
          boxShadow: focused ? 'var(--cr-focus-ring)' : 'none',
          flex: 1,
          minWidth: 0,
          ...style,
        }}
      >
        {icon && (
          <Icon
            name={icon}
            size={15}
            style={{
              position: 'absolute',
              left: 12,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--cr-fg-3)',
            }}
          />
        )}
        <input
          ref={ref}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            width: '100%',
            height: '100%',
            padding: icon ? '0 12px 0 36px' : '0 12px',
            paddingRight: (value && onClear) || kbd ? 40 : 12,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontFamily: 'inherit',
            fontSize: 14,
            color: 'var(--cr-fg-1)',
            letterSpacing: '-0.005em',
          }}
          {...rest}
        />
        {value && onClear && (
          <button
            onClick={onClear}
            style={{
              position: 'absolute',
              right: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 22,
              height: 22,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: 'none',
              borderRadius: 4,
              color: 'var(--cr-fg-3)',
              cursor: 'pointer',
            }}
          >
            <Icon name="x" size={13} />
          </button>
        )}
        {!value && kbd && (
          <Kbd
            style={{
              position: 'absolute',
              right: 10,
              top: '50%',
              transform: 'translateY(-50%)',
            }}
          >
            {kbd}
          </Kbd>
        )}
      </div>
    );
  }
);


// ────────────────────────────── Card ──────────────────────────────
interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
}

export function Card({ children, style, interactive, ...rest }: CardProps) {
  const [hov, setHov] = useState(false);
  return (
    <div
      onMouseEnter={interactive ? () => setHov(true) : undefined}
      onMouseLeave={interactive ? () => setHov(false) : undefined}
      style={{
        background: 'var(--cr-ink-1)',
        border: `1px solid ${hov ? 'var(--cr-line-2)' : 'var(--cr-line-1)'}`,
        borderRadius: 'var(--cr-radius-md)',
        padding: 20,
        transition: 'border-color var(--cr-dur-fast), background var(--cr-dur-fast)',
        cursor: interactive ? 'pointer' : 'default',
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

// ────────────────────────────── MetricCard ──────────────────────────────
interface MetricCardProps {
  label: string;
  value: string;
  sub?: string;
  delta?: string;
  tone?: 'neutral' | 'brand' | 'cost' | 'savings' | 'ok' | 'err';
  icon?: string;
}

export function MetricCard({ label, value, sub, delta, tone = 'neutral', icon }: MetricCardProps) {
  const tones: Record<string, string> = {
    neutral: 'var(--cr-fg-1)',
    brand: 'var(--cr-brand-500)',
    cost: 'var(--cr-warn-500)',
    savings: 'var(--cr-ok-500)',
    ok: 'var(--cr-ok-500)',
    err: 'var(--cr-err-500)',
  };
  return (
    <div
      style={{
        background: 'var(--cr-ink-1)',
        border: '1px solid var(--cr-line-1)',
        borderRadius: 'var(--cr-radius-md)',
        padding: '18px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 12,
          color: 'var(--cr-fg-3)',
          fontWeight: 500,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {icon && <Icon name={icon} size={13} />}
          {label}
        </span>
        {delta && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 500,
              color: delta.startsWith('-') ? 'var(--cr-ok-500)' : 'var(--cr-warn-500)',
            }}
          >
            {delta}
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: 26,
          fontWeight: 600,
          letterSpacing: '-0.02em',
          color: tones[tone],
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
      {sub && <div style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>{sub}</div>}
    </div>
  );
}
