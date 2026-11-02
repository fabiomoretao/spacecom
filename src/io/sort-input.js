import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readGroups } from './read-groups.js';

function* records(file) {
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  let pending = '';
  try {
    let size;
    while ((size = fs.readSync(fd, buffer))) {
      // Runs contain ASCII JSON, so chunk boundaries cannot split UTF-8.
      pending += buffer.toString('ascii', 0, size);
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        yield JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
    }
  } finally { fs.closeSync(fd); }
}
const compare = (a, b) => a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.line - b.line;
const encode = value => JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';

export function withSortedInput(input, reject, stats, consume, { blockSize = 100000, fanIn = 32 } = {}) {
  if (!Number.isInteger(blockSize) || blockSize < 1 || !Number.isInteger(fanIn) || fanIn < 2) throw new Error('Invalid sort limits');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'encounter-sort-'));
  let serial = 0;
  const nextPath = () => path.join(directory, `${serial++}.jsonl`);
  let block = [], runs = [];
  function flush() {
    if (!block.length) return;
    block.sort(compare);
    const file = nextPath();
    fs.writeFileSync(file, block.map(encode).join(''));
    runs.push(file); block = [];
  }
  try {
    readGroups(input, () => {}, reject, stats, { onRecord(record) {
      block.push(record);
      if (block.length === blockSize) flush();
    } });
    flush();
    const linesRead = stats.linesRead;
    while (runs.length > 1) {
      const merged = [];
      for (let i = 0; i < runs.length; i += fanIn) {
        const batch = runs.slice(i, i + fanIn);
        const iterators = batch.map(file => records(file));
        const file = nextPath();
        const fd = fs.openSync(file, 'wx');
        try {
          const heads = iterators.map(iterator => iterator.next());
          while (true) {
            let best = -1;
            for (let j = 0; j < heads.length; j++) if (!heads[j].done && (best < 0 || compare(heads[j].value, heads[best].value) < 0)) best = j;
            if (best < 0) break;
            fs.writeFileSync(fd, encode(heads[best].value));
            heads[best] = iterators[best].next();
          }
        } finally {
          fs.closeSync(fd);
          for (const iterator of iterators) iterator.return();
        }
        merged.push(file);
        for (const old of batch) fs.unlinkSync(old);
      }
      runs = merged;
    }
    consume(runs.length ? records(runs[0]) : []);
    stats.linesRead = linesRead;
  } finally {
    // directory is exclusively created by mkdtemp above.
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
