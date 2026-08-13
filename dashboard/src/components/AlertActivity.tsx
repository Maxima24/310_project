import type { AlertView } from '@cpe310/contracts';
import { useMemo } from 'react';

/**
 * Twelve hours of alert activity as a density strip.
 *
 * Borrowed from the shape a satellite terminal uses to show outages: a row of thin
 * ticks where the ordinary state is a flat baseline and anything worth knowing about
 * sticks up. It answers a question a list cannot — "was it noisy overnight, or is this
 * new?" — in one glance and no scrolling, which is exactly the question fifty stacked
 * rows fail to answer.
 *
 * Height encodes count, colour encodes the worst severity in that slot, and empty
 * slots stay as a faint baseline rather than vanishing, so the passage of quiet time
 * is itself visible.
 */

const HOURS = 12;
const SLOT_MINUTES = 15;
const SLOTS = (HOURS * 60) / SLOT_MINUTES;

interface Slot {
  count: number;
  worst: 'none' | 'info' | 'warning' | 'critical';
}

const RANK = { none: 0, info: 1, warning: 2, critical: 3 } as const;

export function AlertActivity({ alerts }: { alerts: AlertView[] }) {
  const { slots, peak, quietFor } = useMemo(() => {
    const now = Date.now();
    const windowStart = now - HOURS * 60 * 60_000;

    const buckets: Slot[] = Array.from({ length: SLOTS }, () => ({ count: 0, worst: 'none' }));
    let newest = 0;

    for (const alert of alerts) {
      const at = new Date(alert.createdAt).getTime();
      newest = Math.max(newest, at);
      if (at < windowStart) continue;

      const index = Math.min(SLOTS - 1, Math.floor((at - windowStart) / (SLOT_MINUTES * 60_000)));
      const slot = buckets[index];
      slot.count += 1;

      const severity = alert.severity as keyof typeof RANK;
      if (RANK[severity] > RANK[slot.worst]) slot.worst = severity;
    }

    return {
      slots: buckets,
      peak: Math.max(1, ...buckets.map((b) => b.count)),
      quietFor: newest === 0 ? null : now - newest,
    };
  }, [alerts]);

  return (
    <div className="activity">
      <div className="activity-head">
        <span className="label">Last {HOURS}h</span>
        <span className="activity-quiet">
          {quietFor === null
            ? 'no alerts on record'
            : `quiet for ${formatDuration(quietFor)}`}
        </span>
      </div>

      <svg
        className="activity-strip"
        viewBox={`0 0 ${SLOTS * 4} 28`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Alert activity over the last ${HOURS} hours`}
      >
        {slots.map((slot, index) => {
          // A floor of 2px keeps quiet slots visible as a baseline, so a gap reads as
          // "nothing happened" rather than "no data".
          const height = slot.count === 0 ? 2 : 4 + (slot.count / peak) * 22;
          return (
            <rect
              key={index}
              x={index * 4}
              y={28 - height}
              width={2.4}
              height={height}
              rx={1.2}
              className={`tick tick-${slot.worst}`}
            />
          );
        })}
      </svg>

      <div className="activity-axis">
        <span>{HOURS}h ago</span>
        <span>now</span>
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}
