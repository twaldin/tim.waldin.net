'use strict';

// Prints the per-step table of every run-*.jsonl in a results directory and
// the median N* across runs.

const fs = require('node:fs');

const dir = process.argv[2];
const files = fs.readdirSync(dir)
  .filter((f) => /^run-\d+\.jsonl$/.test(f))
  .sort((a, b) => parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10));

const gib = (bytes) => (bytes / 2 ** 30).toFixed(2);
const nStars = [];
const totals = { served: 0, commands: 0, echo: 0, bytes: 0, errors: 0 };

for (const file of files) {
  const lines = fs.readFileSync(`${dir}/${file}`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const calibration = lines.find((l) => l.type === 'calibration');
  const summary = lines.find((l) => l.type === 'summary');
  console.log(`\n${file}  idle connect-to-prompt ms ${JSON.stringify(calibration?.idleMs ?? {})}`);
  console.log('     N  result               first95  added95  echo95  errors  oom  headroom  cpu   wsMiB  swapMiB  containers  lifetime');
  for (const s of lines.filter((l) => l.type === 'step')) {
    const result = `${s.pass ? 'pass' : `FAIL ${s.failed.join(',')}`}${s.valid ? '' : ' INVALID'}`;
    console.log([
      String(s.n).padStart(6), result.padEnd(20), String(s.firstOutputP95Ms).padStart(7),
      String(s.promptAddedP95Ms).padStart(8), String(s.echoP95Ms).padStart(7), String(s.sessionErrors).padStart(7),
      String(s.oomKills).padStart(4), String(s.minHeadroom).padStart(9), String(s.cpuUtil).padStart(5),
      String(s.maxWorkingSetMiB).padStart(7), String(s.maxSwapMiB).padStart(8), String(s.containersAvg).padStart(11),
      String(s.meanLifetimeS).padStart(9),
    ].join(' '));
    for (const [reason, count] of Object.entries(s.errorKinds)) console.log(`        error x${count}: ${reason}`);
  }
  if (!summary) {
    console.log('  no summary: the run did not finish');
    continue;
  }
  console.log(`  N*=${summary.nStar} first failing N=${summary.firstFailN} binding=${summary.bindingSlo.join(',') || 'none'}`
    + `${summary.valid ? '' : ' (INVALID: load generator saturated or no samples)'}`);
  console.log(`  sessions served ${summary.sessionsServed}/${summary.sessionsStarted}, commands ${summary.commandsRun},`
    + ` echo keystrokes ${summary.echoKeystrokes}, bytes relayed ${gib(summary.bytesRelayed)} GiB,`
    + ` errors ${summary.errors} (hostile ${summary.hostileErrors})`);
  if (summary.valid) nStars.push(summary.nStar ?? 0);
  totals.served += summary.sessionsServed;
  totals.commands += summary.commandsRun;
  totals.echo += summary.echoKeystrokes;
  totals.bytes += summary.bytesRelayed;
  totals.errors += summary.errors;
}

const sorted = [...nStars].sort((a, b) => a - b);
const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
console.log(`\nmedian N* = ${median} over ${sorted.length} valid run(s): ${nStars.join(', ')}`
  + (sorted.length > 1 ? `; range ${sorted[0]}..${sorted.at(-1)}` : ''));
console.log(`work: sessions served ${totals.served}, commands ${totals.commands}, echo keystrokes ${totals.echo},`
  + ` bytes relayed ${gib(totals.bytes)} GiB; session errors ${totals.errors} (errors in failing steps included)`);
