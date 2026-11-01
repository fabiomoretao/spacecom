import fs from 'node:fs';

const HEADER = Buffer.from('idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida');
const MAX_ID = Buffer.from('9007199254740991');
const TRUE = Buffer.from('true');
const FALSE = Buffer.from('false');
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MAX_CONSECUTIVE_OUT_OF_ORDER = 1000;

function sameBytes(buffer, start, end, expected) {
  if (end - start !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (buffer[start + i] !== expected[i]) return false;
  }
  return true;
}

function parseId(buffer, start, end) {
  if (start === end) return NaN;
  for (let i = start; i < end; i++) {
    if (buffer[i] < 48 || buffer[i] > 57) return NaN;
  }
  while (start < end - 1 && buffer[start] === 48) start++;
  if (end - start > 16) return NaN;
  if (end - start === 16) {
    for (let i = 0; i < 16; i++) {
      if (buffer[start + i] > MAX_ID[i]) return NaN;
      if (buffer[start + i] < MAX_ID[i]) break;
    }
  }
  let value = 0;
  for (let i = start; i < end; i++) value = value * 10 + (buffer[i] - 48);
  return value;
}

function parseCoordinate(buffer, start, end, limit) {
  const negative = buffer[start] === 45;
  if (negative) start++;
  let whole = 0;
  const first = start;
  while (start < end && buffer[start] >= 48 && buffer[start] <= 57) {
    whole = whole * 10 + buffer[start++] - 48;
    if (whole > limit) return NaN;
  }
  if (start === first || buffer[start++] !== 46) return NaN;
  const digits = end - start;
  if (digits < 1 || digits > 5) return NaN;
  let fraction = 0;
  for (; start < end; start++) {
    if (buffer[start] < 48 || buffer[start] > 57) return NaN;
    fraction = fraction * 10 + buffer[start] - 48;
  }
  const scaled = whole * 100000 + fraction * 10 ** (5 - digits);
  if (scaled > limit * 100000) return NaN;
  return negative ? -scaled : scaled;
}

function timestampStart(buffer, start, end, knownTimestamp, result) {
  result.unchanged = false;
  if (buffer[start] === 34 && buffer[end - 1] === 34) { start++; end--; }
  if (end - start !== 19) return -1;
  // Only the accepted group's copied bytes can bypass calendar validation.
  if (knownTimestamp && sameBytes(buffer, start, end, knownTimestamp)) {
    result.unchanged = true;
    return start;
  }
  for (let i = 0; i < 19; i++) {
    const byte = buffer[start + i];
    if (i === 4 || i === 7) { if (byte !== 45) return -1; }
    else if (i === 10) { if (byte !== 32) return -1; }
    else if (i === 13 || i === 16) { if (byte !== 58) return -1; }
    else if (byte < 48 || byte > 57) return -1;
  }
  const year = (buffer[start] - 48) * 1000 + (buffer[start + 1] - 48) * 100
    + (buffer[start + 2] - 48) * 10 + buffer[start + 3] - 48;
  const month = (buffer[start + 5] - 48) * 10 + buffer[start + 6] - 48;
  const day = (buffer[start + 8] - 48) * 10 + buffer[start + 9] - 48;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (month < 1 || month > 12 || day < 1
    || day > MONTH_DAYS[month - 1] + (month === 2 && leap ? 1 : 0)) return -1;
  if ((buffer[start + 11] - 48) * 10 + buffer[start + 12] - 48 > 23
    || (buffer[start + 14] - 48) * 10 + buffer[start + 15] - 48 > 59
    || (buffer[start + 17] - 48) * 10 + buffer[start + 18] - 48 > 59) return -1;
  return start;
}

function parseRestrictions(buffer, start, end) {
  if (end - start >= 2 && buffer[start] === 34 && buffer[end - 1] === 34) { start++; end--; }
  const restrictions = new Set();
  if (start === end) return restrictions;
  let token = start;
  for (let i = start; i <= end; i++) {
    if (i === end || buffer[i] === 44) {
      const id = parseId(buffer, token, i);
      if (Number.isNaN(id)) return null;
      restrictions.add(id);
      token = i + 1;
    }
  }
  return restrictions;
}

function sameMetadata(a, b) {
  if (a.faction !== b.faction || a.isVictim !== b.isVictim
    || a.restrictions.size !== b.restrictions.size) return false;
  for (const id of a.restrictions) if (!b.restrictions.has(id)) return false;
  return true;
}

export function readGroups(path, onGroup, onReject, stats) {
  let buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  const fields = new Int32Array(8);
  const currentTimestamp = Buffer.alloc(19);
  const timestampResult = { unchanged: false };
  const cache = new Map();
  const group = {
    timestamp: '', count: 0, ids: new Float64Array(64),
    lat: new Int32Array(64), lon: new Int32Array(64), meta: [],
  };
  let sequence = 0;
  let groupLine = 0;
  let consecutive = 0;
  let firstOutOfOrderLine = 0;
  let firstOutOfOrderTimestamp = '';
  let callbackNs = 0n;
  // Scratch values are reused; parsing never commits cache or group state.
  let id, lat, lon, timeStart, metadata, previous, rawChanged;

  function reject(reason, start, end) {
    onReject(stats.linesRead, reason, buffer, start, end);
  }

  function interpret(start, end) {
    fields[0] = start;
    let count = 1;
    for (let i = start; i < end; i++) {
      if (buffer[i] === 59) {
        if (count < 8) fields[count] = i + 1;
        count++;
      }
    }
    if (count !== 7) return 'field-count';
    fields[7] = end + 1;
    id = parseId(buffer, fields[0], fields[1] - 1);
    if (Number.isNaN(id)) return 'invalid-id';
    timeStart = timestampStart(buffer, fields[2], fields[3] - 1, sequence ? currentTimestamp : null, timestampResult);
    if (timeStart < 0) return 'invalid-timestamp';
    lat = parseCoordinate(buffer, fields[3], fields[4] - 1, 90);
    if (Number.isNaN(lat)) return 'invalid-latitude';
    lon = parseCoordinate(buffer, fields[4], fields[5] - 1, 180);
    if (Number.isNaN(lon)) return 'invalid-longitude';
    previous = cache.get(id);
    rawChanged = !previous
      || !sameBytes(buffer, fields[1], fields[2] - 1, previous.factionBytes)
      || !sameBytes(buffer, fields[5], end, previous.tailBytes);
    if (!rawChanged) { metadata = previous.snapshot; return null; }
    const isVictim = sameBytes(buffer, fields[5], fields[6] - 1, TRUE);
    if (!isVictim && !sameBytes(buffer, fields[5], fields[6] - 1, FALSE)) return 'invalid-boolean';
    const restrictions = parseRestrictions(buffer, fields[6], end);
    if (restrictions === null) return 'invalid-restriction-list';
    if (!isVictim) restrictions.clear();
    // Latin-1 maps each byte to one code unit, preserving opaque faction identity.
    metadata = { faction: buffer.toString('latin1', fields[1], fields[2] - 1), isVictim, restrictions };
    if (previous && sameMetadata(previous.snapshot, metadata)) metadata = previous.snapshot;
    return null;
  }

  function flushGroup() {
    const start = process.hrtime.bigint();
    try { onGroup(group); stats.groups++; }
    finally { callbackNs += process.hrtime.bigint() - start; }
  }

  function acceptLine(start, end) {
    let order = 0;
    if (sequence && !timestampResult.unchanged) {
      for (let i = 0; i < 19; i++) {
        order = buffer[timeStart + i] - currentTimestamp[i];
        if (order) break;
      }
    }
    if (order < 0) {
      if (consecutive === 0) {
        firstOutOfOrderLine = stats.linesRead;
        firstOutOfOrderTimestamp = buffer.toString('ascii', timeStart, timeStart + 19);
      }
      reject('out-of-order-timestamp', start, end);
      if (++consecutive === MAX_CONSECUTIVE_OUT_OF_ORDER) {
        throw new Error(`Systematic out-of-order timestamps: sequence starts at line ${firstOutOfOrderLine} (${firstOutOfOrderTimestamp}); current group ${group.timestamp} started at line ${groupLine}`);
      }
      return;
    }
    if (!sequence || order > 0) {
      if (sequence) flushGroup();
      sequence++;
      group.count = 0;
      groupLine = stats.linesRead;
      buffer.copy(currentTimestamp, 0, timeStart, timeStart + 19);
      group.timestamp = currentTimestamp.toString('ascii');
    }
    if (previous?.sequence === sequence) {
      const index = previous.index;
      const identical = group.lat[index] === lat && group.lon[index] === lon
        && sameMetadata(group.meta[index], metadata);
      reject(identical ? 'duplicate-identical' : 'duplicate-conflicting', start, end);
      return;
    }
    if (group.count === group.ids.length) {
      const capacity = group.ids.length * 2;
      for (const key of ['ids', 'lat', 'lon']) {
        const expanded = new group[key].constructor(capacity);
        expanded.set(group[key]);
        group[key] = expanded;
      }
    }
    const index = group.count++;
    group.ids[index] = id;
    group.lat[index] = lat;
    group.lon[index] = lon;
    group.meta[index] = metadata;
    consecutive = 0;
    stats.acceptedRecords++;
    if (previous && previous.snapshot !== metadata) stats.metadataChanges++;
    if (!previous || rawChanged) {
      cache.set(id, {
        sequence, index, snapshot: metadata,
        factionBytes: Buffer.from(buffer.subarray(fields[1], fields[2] - 1)),
        tailBytes: Buffer.from(buffer.subarray(fields[5], end)),
      });
    } else { previous.sequence = sequence; previous.index = index; }
  }

  function processLine(start, end) {
    stats.linesRead++;
    if (end > start && buffer[end - 1] === 13) end--;
    if (stats.linesRead === 1) {
      if (buffer[start] === 0xef && buffer[start + 1] === 0xbb && buffer[start + 2] === 0xbf) start += 3;
      if (!sameBytes(buffer, start, end, HEADER)) throw new Error('Invalid input header');
      return;
    }
    const reason = interpret(start, end);
    if (reason) reject(reason, start, end);
    else acceptLine(start, end);
  }

  const fd = fs.openSync(path, 'r');
  let used = 0;
  let scanned = 0;
  try {
    while (true) {
      if (used === buffer.length) {
        const expanded = Buffer.allocUnsafe(buffer.length * 2);
        buffer.copy(expanded, 0, 0, used);
        buffer = expanded;
      }
      const readStart = process.hrtime.bigint();
      let bytes;
      try { bytes = fs.readSync(fd, buffer, used, buffer.length - used, null); }
      finally { stats.timingsMs.read += Number(process.hrtime.bigint() - readStart) / 1e6; }
      const parseStart = process.hrtime.bigint();
      const callbacksBefore = callbackNs;
      try {
        if (bytes === 0) {
          if (used) processLine(0, used);
          if (stats.linesRead === 0) throw new Error('Input is empty: missing header');
          if (sequence) flushGroup();
          break;
        }
        const end = used + bytes;
        let start = 0;
        const chunk = buffer.subarray(0, end);
        let newline = chunk.indexOf(10, scanned);
        while (newline !== -1) {
          processLine(start, newline);
          start = newline + 1;
          newline = chunk.indexOf(10, start);
        }
        buffer.copyWithin(0, start, end);
        used = end - start;
        scanned = used;
      } finally {
        stats.timingsMs.parseAndGroup += Number(process.hrtime.bigint() - parseStart
          - (callbackNs - callbacksBefore)) / 1e6;
      }
    }
  } finally { fs.closeSync(fd); }
}
