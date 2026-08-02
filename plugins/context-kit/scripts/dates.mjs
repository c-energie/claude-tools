#!/usr/bin/env node
// FlexSense date maths. Deterministic replacement for "work out today + a week" in prose.
// Pure UTC calendar arithmetic — no timezone drift, no GNU-vs-BSD `date` portability trap.
//
//   node dates.mjs today
//   node dates.mjs add weekly                  # today + 7d
//   node dates.mjs add fortnightly|monthly|30d
//   node dates.mjs add weekly --from 2026-07-20
//   node dates.mjs window 7                    # {from: today, to: today+7}
//   node dates.mjs age 2026-06-01              # whole days elapsed since a date
//
// All output is YYYY-MM-DD (or JSON for `window`). Exit 2 on bad input.

const CADENCE = { daily: 1, weekly: 7, fortnightly: 14, monthly: 30, quarterly: 91 };

const die = (m) => { console.error(`dates.mjs: ${m}`); process.exit(2); };
const iso = (d) => d.toISOString().slice(0, 10);

function parse(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) die(`not a YYYY-MM-DD date: ${s}`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) die(`invalid date: ${s}`);
  return d;
}

function days(spec) {
  if (spec in CADENCE) return CADENCE[spec];
  const m = /^(\d+)\s*d(ays?)?$/.exec(spec);
  if (m) return Number(m[1]);
  die(`unknown cadence: ${spec} (use ${Object.keys(CADENCE).join('|')} or "<n>d")`);
}

function shift(from, n) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const fromIdx = argv.indexOf('--from');
const today = fromIdx === -1 ? new Date(`${iso(new Date())}T00:00:00Z`) : parse(argv[fromIdx + 1] ?? '');

switch (cmd) {
  case 'today':
    console.log(iso(today));
    break;
  case 'add':
    if (!argv[1]) die('add needs a cadence');
    console.log(iso(shift(today, days(argv[1]))));
    break;
  case 'window': {
    const n = Number(argv[1] ?? 7);
    if (!Number.isInteger(n)) die('window needs an integer number of days');
    console.log(JSON.stringify({ from: iso(today), to: iso(shift(today, n)) }));
    break;
  }
  case 'age': {
    const then = parse(argv[1] ?? '');
    console.log(Math.round((today - then) / 86400000));
    break;
  }
  default:
    die('usage: today | add <cadence> | window <days> | age <date>   [--from YYYY-MM-DD]');
}