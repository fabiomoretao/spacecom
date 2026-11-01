import { resolve } from 'node:path';
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
      sortAndScan: 0, haversineAndClassification: 0, write: 0, total: 0,
    },
  };
}

export function processDataset(input, output, rejects = `${output}.rejects.jsonl`, stats = createStats()) {
  const started = process.hrtime.bigint();
  let log;
  let writer;
  try {
    const paths = [input, output, rejects].map((path) => {
      const absolute = resolve(path);
      return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    });
    if (new Set(paths).size !== 3) throw new Error('Input, output and rejection log paths must be distinct');
    log = createRejectLog(rejects, stats);
    writer = createOutput(output);
    const encounters = [];
    const sortState = { order: [], ids: [] };
    readGroups(input, (group) => {
      const start = process.hrtime.bigint();
      try {
        const result = findEncounters(group, stats.timingsMs, sortState);
        for (const encounter of result.encounters) {
          encounters.push(encounter);
          stats.encounters[encounter.tipo]++;
        }
        stats.genericWithVictim += result.genericWithVictim;
      } finally { stats.timingsMs.detection += Number(process.hrtime.bigint() - start) / 1e6; }
    }, log.reject, stats);
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
