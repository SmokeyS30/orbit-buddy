// Time-aware briefing layouts — frontend presentation config for the Today tab.
// The phase itself is computed server-side (src/briefing.js#getBriefingPhase,
// boundaries in BRIEFING_PHASES); this module only maps a resolved phase id to
// the tab label, section order, and card titles the briefing tab renders. No
// clock logic lives here: the UI never computes a phase from the time.
//
// Section keys understood by renderBriefing in app.js:
//   weather        — current conditions + 3-day forecast
//   agenda         — today's calendar events
//   focus          — focus goals with progress bars
//   loops          — approvals, approval-gated tasks, due follow-ups
//   anniversaries  — personal dates in the next 14 days
//   tomorrow       — tomorrow's calendar preview (evening only)
export const BRIEFING_LAYOUTS = {
  morning: {
    tabLabel: 'Morning briefing',
    sections: [
      { key: 'weather' },
      { key: 'agenda', title: 'Today', emptyText: 'Nothing scheduled — the day is yours.', tomorrowLine: true },
      { key: 'focus', title: 'Focus' },
      { key: 'loops', title: 'Open loops' },
      { key: 'anniversaries', title: 'Coming up' },
    ],
  },
  afternoon: {
    tabLabel: 'Afternoon check-in',
    sections: [
      { key: 'focus', title: 'Momentum' },
      { key: 'loops', title: 'Still to do' },
      { key: 'agenda', title: 'Today so far', splitDay: true, emptyText: 'Nothing on the calendar today.' },
      { key: 'weather' },
      { key: 'anniversaries', title: 'Coming up' },
    ],
  },
  evening: {
    tabLabel: 'Evening recap',
    sections: [
      { key: 'agenda', title: 'The day that was', emptyText: 'Nothing was scheduled today.' },
      { key: 'loops', title: 'Still open' },
      { key: 'focus', title: 'Momentum' },
      { key: 'tomorrow', title: 'Tomorrow' },
      { key: 'anniversaries', title: 'Coming up' },
      { key: 'weather' },
    ],
  },
};

// Unknown or missing phase ids (e.g. a stale cached payload from before this
// feature shipped) fall back to the morning layout — the previous behavior.
export function briefingLayoutFor(phaseId) {
  return BRIEFING_LAYOUTS[phaseId] || BRIEFING_LAYOUTS.morning;
}
