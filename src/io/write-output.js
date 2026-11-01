import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export function createOutput(path) {
  let temporary = `${path}.${randomUUID()}.tmp`;
  let fd = fs.openSync(temporary, 'wx');
  return {
    publish(encounters) {
      fs.writeFileSync(fd, JSON.stringify(encounters, null, 2));
      const handle = fd;
      fd = undefined;
      fs.closeSync(handle);
      fs.renameSync(temporary, path);
      temporary = undefined;
    },
    abort() {
      if (temporary === undefined) return;
      try {
        if (fd !== undefined) { const handle = fd; fd = undefined; fs.closeSync(handle); }
      } finally { fs.rmSync(temporary, { force: true }); }
    },
  };
}
