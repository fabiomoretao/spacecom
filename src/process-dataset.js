import fs from 'node:fs';
import { withSortedInput } from './io/sort-input.js';
import { dirname, basename, resolve } from 'node:path';
import { readGroups } from './io/read-groups.js';
import { createRejectLog } from './io/reject-log.js';
import { createOutput } from './io/write-output.js';
import { findEncounters } from './domain/find-encounters.js';

export function createStats() {
  return {
    linesRead: 0, acceptedRecords: 0, rejectedRecords: 0, rejections: {},
    metadataChanges: 0, groups: 0,
    encounters: { protetiva: 0, faccao: 0, generico: 0 }, genericWithVictim: 0,
    timingsMs: {
      read: 0, parseAndGroup: 0, detection: 0,
      write: 0, total: 0,
    },
  };
}

export function processDataset(input, output, rejects = `${output}.rejects.jsonl`, stats = createStats(), sortOptions = {}) {
  const started = process.hrtime.bigint();
  let log;
  let writer;
  try {
    const paths = [input, output, rejects].map((path) => {
      let absolute = resolve(path);
      if (fs.existsSync(absolute)) absolute = fs.realpathSync(absolute);
      else {
        let parent = dirname(absolute), suffix = basename(absolute);
        while (!fs.existsSync(parent)) { suffix = basename(parent) + '/' + suffix; parent = dirname(parent); }
        absolute = resolve(fs.realpathSync(parent), suffix);
      }
      return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    });
    if (new Set(paths).size !== 3) throw new Error('Input, output and rejection log paths must be distinct');
    const existing = [input, output, rejects].filter(p => fs.existsSync(p)).map(p => fs.statSync(p));
    for (let i = 0; i < existing.length; i++) for (let j = i + 1; j < existing.length; j++) {
      if (existing[i].dev === existing[j].dev && existing[i].ino === existing[j].ino) throw new Error('Paths alias the same file');
    }
    fs.mkdirSync(dirname(resolve(output)), { recursive: true });
    fs.mkdirSync(dirname(resolve(rejects)), { recursive: true });
    log = createRejectLog(rejects, stats);
    writer = createOutput(output);
    const encounters = [];
    const sortState = { order: [], ids: [] };
    const consumeGroup = (group) => {
      const start = process.hrtime.bigint();
      try {
        const result = findEncounters(group, stats.timingsMs, sortState);
        for (const encounter of result.encounters) {
          encounters.push(encounter);
          stats.encounters[encounter.tipo]++;
        }
        stats.genericWithVictim += result.genericWithVictim;
      } finally { stats.timingsMs.detection += Number(process.hrtime.bigint() - start) / 1e6; }
    };
    try { readGroups(input, consumeGroup, log.reject, stats); }
    catch (error) {
      if (error.code !== 'UNSORTED') throw error;
      log.close();
      Object.assign(stats, createStats());
      encounters.length = 0;
      sortState.order = []; sortState.ids = [];
      log = createRejectLog(rejects, stats);
      stats.externalSort = true;
      withSortedInput(input, log.reject, stats, records => {
        readGroups(input, consumeGroup, log.reject, stats, { records });
      }, sortOptions);
    }
    if (Object.entries(stats.rejections).some(([reason, count]) => count && reason !== 'duplicate-identical')) {
      throw new Error('Invalid or conflicting records: review rejection log; output was not published');
    }
    // Closing the log must succeed before the output can be published.
    log.close();
    const start = process.hrtime.bigint();
    try { writer.publish(encounters); }
    finally { stats.timingsMs.write += Number(process.hrtime.bigint() - start) / 1e6; }
    return stats;
  } finally {
    try { log?.close(); }
    finally {
      try { writer?.abort(); }
      finally { stats.timingsMs.total = Number(process.hrtime.bigint() - started) / 1e6; }
    }
  }
}
