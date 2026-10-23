#!/usr/bin/env node
// Audit a set of repositories' open issues for a Sandcastle `--epic` run: what the epic will
// obey (native sub-issues and blocked-by links), what it will only list (dependencies written in
// issue text), and what it will silently drop or hold.
//
//   node epic-audit.mjs --repos owner/a,owner/b [--config sandcastle.config.mts] [--json]
//
// Read-only: GET and GraphQL queries as the caller's own `gh` login, nothing written. The writes
// the audit points at are the skill's job, one approved plan at a time.
//
// Why a script: which links are native, which are text only, which issues no parent reaches and
// which repositories are not members are facts about GitHub and the config, and they come out
// the same every time. The judgement (is "companion to #41" a dependency? in which direction?)
// stays with the skill.
//
// The text-link reader is a PORT of `textLinksIn` in c-energie/sandcastle-harness src/epic.mts
// (checked against v2.12.0), so "text only" here means exactly what the epic's planner will list
// as an unconfirmed link. When the harness changes that function, change this one.
//
// Needs only `gh` (authenticated) and Node. No jq: it is not on every machine this runs on.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const asJson = args.includes('--json');
const repos = (opt('repos') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (repos.length === 0 || repos.some((r) => !/^[\w.-]+\/[\w.-]+$/.test(r))) {
  console.error('epic-audit.mjs: needs --repos owner/repo[,owner/repo...]');
  process.exit(2);
}
const configPath = opt('config') ?? (existsSync('sandcastle.config.mts') ? 'sandcastle.config.mts' : undefined);

// --- the harness's own vocabulary ---------------------------------------------------------------

const EPIC_LABEL = 'ready-for-agent'; // src/epic.mts EPIC_LABEL
const STATE_LABELS = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'];

// --- textLinksIn, ported from sandcastle-harness src/epic.mts ------------------------------------

const DEPENDENCY_PHRASE = /\b(?:blocked\s+by|depends\s+on|after)\b/gi;
const TEXT_REF = /(?<![\w/#&.-])(?:([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+))?#([1-9]\d*)\b/g;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const sentenceOf = (rest) => rest.split(/[.;!?](?:\s|$)/)[0];
const key = (r) => `${r.owner}/${r.repo}#${r.number}`.toLowerCase();

// Returns the harness's links, plus PROSE: a dependency phrase that named no issue at all
// ("blocked by the implementation tickets above"). The planner sees nothing there, not even an
// unconfirmed link, so it is the easiest dependency to lose.
const textLinksIn = (body, self) => {
  const lines = body.replace(/```[\s\S]*?(?:```|$)/g, '').split(/\r?\n/);
  const found = [];
  const prose = [];
  const seen = new Set([key(self)]);
  const take = (text, quote) => {
    let n = 0;
    for (const m of text.matchAll(TEXT_REF)) {
      n++;
      const ref = { owner: m[1] ?? self.owner, repo: m[2] ?? self.repo, number: Number(m[3]) };
      if (seen.has(key(ref))) continue;
      seen.add(key(ref));
      found.push({ ref, quote: quote.length > 160 ? quote.slice(0, 157) + '...' : quote });
    }
    return n;
  };
  lines.forEach((line, i) => {
    for (const phrase of line.matchAll(DEPENDENCY_PHRASE)) {
      const rest = line.slice(phrase.index + phrase[0].length);
      if (rest.replace(/[\s:*_#`]/g, '') !== '') {
        if (take(sentenceOf(rest), line.trim()) === 0 && /^blocked|^depends/i.test(phrase[0])) {
          prose.push(line.slice(phrase.index).trim().slice(0, 160));
        }
        continue;
      }
      const label = line.replace(/^[\s#>*_]+|[\s:*_]+$/g, '');
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (next.trim() === '') continue;
        if (!LIST_ITEM.test(next)) break;
        take(next, label + ': ' + next.trim());
      }
    }
  });
  return { links: found, prose };
};

// --- GitHub ---------------------------------------------------------------------------------------

const gh = (query, vars) => {
  const a = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) a.push(v === null ? '-F' : '-f', `${k}=${v ?? 'null'}`);
  return JSON.parse(execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
};

const REF = 'number state stateReason repository { nameWithOwner }';
const QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url body
        labels(first: 30) { nodes { name } }
        comments(last: 10) { nodes { body } }
        parent { ${REF} }
        subIssues(first: 100) { nodes { ${REF} } }
        blockedBy(first: 100) { nodes { ${REF} } }
        blocking(first: 100) { nodes { ${REF} } }
      }
    }
  }
}`;

const refOf = (n) => {
  const [owner, repo] = n.repository.nameWithOwner.split('/');
  return { owner, repo, number: n.number, state: n.state, stateReason: n.stateReason };
};

const issues = new Map(); // key -> issue, every OPEN issue in scope
const known = new Map(); // key -> {state}, anything a link named
for (const full of repos) {
  const [owner, name] = full.split('/');
  let after = null;
  do {
    let page;
    try {
      page = gh(QUERY, { owner, name, after }).data.repository.issues;
    } catch (e) {
      console.error(`epic-audit.mjs: cannot read ${full}: ${String(e.stderr || e.message).trim().split('\n').pop()}`);
      process.exit(1);
    }
    for (const n of page.nodes) {
      const self = { owner, repo: name, number: n.number };
      const lists = {};
      for (const f of ['subIssues', 'blockedBy', 'blocking']) {
        lists[f] = n[f].nodes.map(refOf);
        for (const r of lists[f]) known.set(key(r), r);
      }
      const parent = n.parent ? refOf(n.parent) : null;
      if (parent) known.set(key(parent), parent);
      const text = textLinksIn(n.body ?? '', self);
      issues.set(key(self), {
        ...self,
        title: n.title,
        url: n.url,
        labels: n.labels.nodes.map((l) => l.name),
        parent,
        ...lists,
        textLinks: text.links,
        prose: text.prose,
        // The last "Why ready-for-X" anywhere in the body or comments: which state the prose argues for.
        statedState: [n.body ?? '', ...n.comments.nodes.map((c) => c.body)]
          .flatMap((b) => [...b.matchAll(/why\s+(ready-for-agent|ready-for-human)/gi)].map((m) => m[1].toLowerCase()))
          .pop() ?? null,
      });
      known.set(key(self), { ...self, state: 'OPEN' });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
}

// --- members, from the workspace's config ---------------------------------------------------------

let members = null; // null = no config read
if (configPath) {
  const src = readFileSync(configPath, 'utf8');
  members = new Set(
    [...src.matchAll(/owner:\s*["']([^"']+)["']\s*,\s*repo:\s*["']([^"']+)["']/g)].map((m) => `${m[1]}/${m[2]}`.toLowerCase()),
  );
}
const isMember = (r) => members === null || members.has(`${r.owner}/${r.repo}`.toLowerCase());

// --- findings -------------------------------------------------------------------------------------

const all = [...issues.values()];
const fmt = (r) => `${r.owner}/${r.repo}#${r.number}`;

// Parents: open issues with sub-issues. The parents are not tasks.
const parents = all.filter((i) => i.subIssues.length > 0);

// What some parent reaches through native links, both directions, as the planner reads it.
const reached = new Set();
const queue = parents.map(key);
while (queue.length) {
  const k = queue.pop();
  if (reached.has(k)) continue;
  reached.add(k);
  const i = issues.get(k);
  if (!i) continue;
  for (const r of [...i.subIssues, ...i.blockedBy, ...i.blocking]) if (r.state === 'OPEN') queue.push(key(r));
}

const textOnly = [];
for (const i of all) {
  const native = new Set(i.blockedBy.map(key));
  for (const t of i.textLinks) {
    if (native.has(key(t.ref))) continue;
    const target = known.get(key(t.ref));
    textOnly.push({ issue: fmt(i), target: fmt(t.ref), targetState: target?.state ?? 'unread', quote: t.quote });
  }
}

const prose = all.filter((i) => i.prose.length).map((i) => ({ issue: fmt(i), lines: i.prose }));

const labelProblems = [];
for (const i of all) {
  const states = i.labels.filter((l) => STATE_LABELS.includes(l));
  if (states.length !== 1) labelProblems.push({ issue: fmt(i), problem: `${states.length} state labels (${states.join(', ') || 'none'})` });
  else if (i.statedState && i.statedState !== states[0])
    labelProblems.push({ issue: fmt(i), problem: `labelled ${states[0]}, but its text last argues "why ${i.statedState}"` });
}

const nonMembers = members === null ? [] : repos.filter((r) => !members.has(r.toLowerCase()));
const outsideBlockers = [];
for (const i of all)
  for (const b of i.blockedBy)
    if (b.state === 'OPEN' && !isMember(b)) outsideBlockers.push({ issue: fmt(i), blocker: fmt(b) });

// Cycles among native blocked-by links in scope.
const cycles = [];
{
  const colour = new Map();
  const stack = [];
  const visit = (k) => {
    colour.set(k, 1);
    stack.push(k);
    for (const b of issues.get(k)?.blockedBy ?? []) {
      const bk = key(b);
      if (b.state !== 'OPEN' || !issues.has(bk)) continue;
      if (colour.get(bk) === 1) cycles.push(stack.slice(stack.indexOf(bk)).concat(bk));
      else if (!colour.get(bk)) visit(bk);
    }
    stack.pop();
    colour.set(k, 2);
  };
  for (const k of issues.keys()) if (!colour.get(k)) visit(k);
}

const linked = (i) => i.subIssues.length || i.blockedBy.length || i.blocking.length || i.parent || i.textLinks.length;
const unreached = all.filter((i) => !reached.has(key(i)) && linked(i));
const isolated = all.filter((i) => !reached.has(key(i)) && !linked(i));

const report = {
  repos,
  config: configPath ?? null,
  nonMembers,
  parents: parents.map((p) => ({ issue: fmt(p), title: p.title, subIssues: p.subIssues.length, promoted: p.labels.includes(EPIC_LABEL) })),
  unreached: unreached.map((i) => ({ issue: fmt(i), title: i.title })),
  isolated: isolated.map((i) => fmt(i)),
  textOnly,
  prose,
  labelProblems,
  outsideBlockers,
  cycles,
  native: all
    .filter((i) => i.blockedBy.length)
    .map((i) => ({ issue: fmt(i), blockedBy: i.blockedBy.map((b) => fmt(b) + (b.state === 'OPEN' ? '' : ' (closed)')) })),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const out = [];
const section = (title, rows, empty) => {
  out.push(`\n## ${title}`);
  if (rows.length === 0) out.push(`  ${empty}`);
  else out.push(...rows.map((r) => '  ' + r));
};
out.push(`epic-audit: ${all.length} open issues in ${repos.join(', ')}`);
out.push(configPath ? `members read from ${configPath}` : 'no sandcastle.config.mts read: membership NOT checked');
section('Repositories that are not members (their issues are dropped, and their dependents flagged)', nonMembers, 'none');
section(
  'Parents (issues with sub-issues)',
  report.parents.map((p) => `${p.issue}  ${p.subIssues} sub-issues  ${p.title.slice(0, 60)}${p.promoted ? '  [labelled ready-for-agent: a parent is never a task]' : ''}`),
  'none: --epic needs at least one parent issue',
);
section('Linked, but no parent reaches them (outside every epic)', report.unreached.map((u) => `${u.issue}  ${u.title.slice(0, 70)}`), 'none');
section('Dependencies in text only (the plan lists them as unconfirmed; nothing obeys them)', textOnly.map((t) => `${t.issue} <- ${t.target} [${t.targetState}]  "${t.quote}"`), 'none');
section('Dependencies in prose that name no issue (invisible to the planner; check the native links cover them)', prose.flatMap((p) => p.lines.map((l) => `${p.issue}  "${l}"`)), 'none');
section('Label problems', labelProblems.map((l) => `${l.issue}  ${l.problem}`), 'none');
section('Open blockers outside every member (dependents will be flagged)', outsideBlockers.map((o) => `${o.issue} <- ${o.blocker}`), members === null ? 'not checked' : 'none');
section('Cycles (the epic refuses to plan)', cycles.map((c) => c.join(' -> ')), 'none');
section('Native blocked-by links already in place', report.native.map((n) => `${n.issue} <- ${n.blockedBy.join(', ')}`), 'none');
out.push(`\n${isolated.length} open issue(s) have no link of any kind and are left out above.`);
console.log(out.join('\n'));
