#!/usr/bin/env node
// The canonical section headings for this plugin's Slack posts, icons included.
//
// This file exists because the icons drifted once already: the weekly roundup carried a full
// set on 29 Jul and 3 Aug 2026 and none at all by 11 Aug, because the roundup was composed
// freehand each week with nothing holding its format. Anything that must come out identically
// every time belongs in a script rather than in prose — so the vocabulary lives here, and both
// consumers read it from here.
//
//   node slack-sections.mjs           # -> the table, for a skill to quote
//   node slack-sections.mjs --json    # -> { shared: {...}, roundup: {...} }
//
// SHARED are the five buckets person-digest.mjs renders per person. The weekly roundup uses the
// same five for the same meaning — that is the whole point of sharing them — and adds ROUNDUP
// for the three things a roundup reports that a per-person digest cannot know about.

export const SHARED = {
  overdue:       '⏰ Overdue / due this week',
  open:          '✅ Other open actions',
  watching:      '👀 Watching (grants / events / reminders)',
  questions:     '❓ Questions to chase',
  relationships: '🤝 Relationships',
};

export const ROUNDUP = {
  revisit:     '🗳️ Decisions due to revisit',
  housekeeping:'🧹 Housekeeping',
  lastMeeting: '📝 Last meeting',
};

// The roundup's own header icon. The digest has no icon on its header — it opens with a person.
export const ROUNDUP_HEADER = '📋';

const isMain = (process.argv[1] ?? '').endsWith('slack-sections.mjs');
if (isMain) {
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ shared: SHARED, roundup: ROUNDUP, roundupHeader: ROUNDUP_HEADER }, null, 2));
  } else {
    console.log(`Header: ${ROUNDUP_HEADER} (roundup only)\n`);
    console.log('Shared with person-digest.mjs — same icon, same meaning:');
    for (const [k, v] of Object.entries(SHARED)) console.log(`  ${k.padEnd(14)} ${v}`);
    console.log('\nRoundup only:');
    for (const [k, v] of Object.entries(ROUNDUP)) console.log(`  ${k.padEnd(14)} ${v}`);
  }
}
