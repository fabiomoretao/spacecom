import fs from 'node:fs';

export function createRejectLog(path, stats) {
  fs.rmSync(path, { force: true });
  let fd;
  return {
    reject(line, reason, buffer, start, end) {
      stats.rejectedRecords++;
      stats.rejections[reason] = (stats.rejections[reason] ?? 0) + 1;
      if (fd === undefined) fd = fs.openSync(path, 'wx');
      const raw = buffer.toString('utf8', start, Math.min(end, start + 800)).slice(0, 200);
      fs.writeFileSync(fd, `${JSON.stringify({ line, reason, raw })}\n`);
    },
    close() {
      if (fd !== undefined) { const handle = fd; fd = undefined; fs.closeSync(handle); }
    },
  };
}
