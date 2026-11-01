import { resolve } from 'node:path';
import { createStats, processDataset } from './process-dataset.js';

const stats = createStats();
const started = process.hrtime.bigint();
let rejects;
try {
  const args = process.argv.slice(2);
  if ((args.length !== 2 && args.length !== 4)
    || args.slice(0, 2).some((arg) => !arg || arg.startsWith('--'))
    || (args.length === 4 && (args[2] !== '--rejects' || !args[3] || args[3].startsWith('--')))) {
    throw new Error('Usage: node src/cli.js <input> <output> [--rejects <path>]');
  }
  rejects = resolve(args[3] ?? `${args[1]}.rejects.jsonl`);
  processDataset(args[0], args[1], rejects, stats);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
} finally {
  stats.timingsMs.total = Number(process.hrtime.bigint() - started) / 1e6;
  console.error(`Summary: ${JSON.stringify(stats)}`);
  if (stats.rejectedRecords) {
    console.error(`WARNING: ${stats.rejectedRecords} rejected records; review ${rejects}`);
  }
}
