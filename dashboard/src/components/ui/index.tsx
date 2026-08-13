import type { ReactNode } from 'react';

import { Icon, type IconName } from './Icon';

export { Icon };
export type { IconName };

/**
 * UI primitives.
 *
 * Every panel, pill, and stat on the dashboard is one of these, so a change to the
 * system lands everywhere at once rather than in the twelve places a pattern was
 * copied to. The tone vocabulary below is the same set the hub uses for severity, so
 * "critical" means one thing across the API, the styles, and the components.
 */

export type Tone = 'ok' | 'warn' | 'critical' | 'info' | 'idle' | 'brand';

/* -------------------------------------------------------------------- card */

export function Card({
  title,
  icon,
  badge,
  actions,
  children,
  flush,
  className = '',
}: {
  title?: ReactNode;
  icon?: IconName;
  badge?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Content runs to the card edge — for lists and media that supply their own padding. */
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && (
            <h2 className="card-title">
              {icon && <Icon name={icon} size={15} />}
              {title}
              {badge}
            </h2>
          )}
          {actions && <div className="card-head-actions">{actions}</div>}
        </header>
      )}
      <div className={flush ? 'card-body card-body-flush' : 'card-body'}>{children}</div>
    </section>
  );
}

/* -------------------------------------------------------------------- stat */

export function Stat({
  label,
  icon,
  value,
  unit,
  delta,
  deltaTone = 'idle',
  bar,
}: {
  label: string;
  icon?: IconName;
  value: ReactNode;
  unit?: string;
  /** The change, not just the level — a number without movement hides the story. */
  delta?: string;
  deltaTone?: Tone;
  /** Proportional segments, drawn as a thin bar under the value. */
  bar?: Array<{ value: number; tone: Tone }>;
}) {
  const total = bar?.reduce((sum, part) => sum + part.value, 0) ?? 0;

  return (
    <article className="stat">
      <div className="stat-head">
        {icon && <Icon name={icon} size={15} />}
        <span>{label}</span>
        {delta && <span className={`delta delta-${deltaTone}`}>{delta}</span>}
      </div>

      <div className="stat-value-row">
        <span className="stat-value">{value}</span>
        {unit && <span className="stat-unit">{unit}</span>}
      </div>

      {bar && total > 0 && (
        <div className="stat-bar">
          {bar.map((part, index) => (
            <span
              key={index}
              style={{
                width: `${(part.value / total) * 100}%`,
                background: `var(--${part.tone === 'idle' ? 'idle' : part.tone})`,
              }}
            />
          ))}
        </div>
      )}
    </article>
  );
}

/* -------------------------------------------------------------------- pill */

export function Pill({
  tone = 'idle',
  dot,
  children,
}: {
  tone?: Tone;
  /** A leading dot, for states worth spotting without reading. */
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`pill pill-${tone}`}>
      {dot && <span className="pill-dot" />}
      {children}
    </span>
  );
}

export function CountBadge({ children }: { children: ReactNode }) {
  return <span className="count-badge">{children}</span>;
}

/* ------------------------------------------------------------------ button */

export function Button({
  variant = 'default',
  size,
  icon,
  children,
  ...rest
}: {
  variant?: 'default' | 'primary' | 'ghost';
  size?: 'sm';
  icon?: IconName;
  children?: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = [
    'btn',
    variant === 'primary' ? 'btn-primary' : '',
    variant === 'ghost' ? 'btn-ghost' : '',
    size === 'sm' ? 'btn-sm' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classes} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 13 : 15} />}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  plain,
  ...rest
}: {
  icon: IconName;
  /** Required: an icon-only control is invisible to a screen reader without it. */
  label: string;
  plain?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`icon-btn ${plain ? 'icon-btn-plain' : ''}`} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={17} />
    </button>
  );
}

/* ------------------------------------------------------------------ banner */

export function Banner({
  tone = 'info',
  icon = 'alert',
  children,
}: {
  tone?: 'critical' | 'info';
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'critical' ? 'alert' : undefined}>
      <Icon name={icon} size={16} />
      <div>{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------- empty */

export function Empty({ icon = 'signal', children }: { icon?: IconName; children: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={26} />
      <span>{children}</span>
    </div>
  );
}
