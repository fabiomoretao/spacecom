import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const repetitions = 10;
const counts = [4, 6, 10, 15, 21, 27];
const quotePS = (value) => `'${value.replaceAll("'", "''")}'`;
const sourceFiles = ['src/cli.js', 'src/process-dataset.js', 'src/io/read-groups.js',
  'src/io/reject-log.js', 'src/io/write-output.js', 'src/domain/find-encounters.js',
  'src/domain/haversine.js', 'src/domain/classify-encounter.js'];

function powershell(script) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference = 'Stop';\n${script}`, 'utf16le').toString('base64')], {
    cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
}

function hashFile(file) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function warmCache(file) {
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try { while (fs.readSync(fd, buffer, 0, buffer.length, null)) { /* Excluded from timing. */ } }
  finally { fs.closeSync(fd); }
}

function measure(cli, input, output) {
  // External sampling of the OS lifetime peak; internal maxRSS permits cross-checks.
  return powershell(`
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = ${quotePS(process.execPath)}
$info.Arguments = ${quotePS(`"${cli}" "${input}" "${output}"`)}
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$child = New-Object System.Diagnostics.Process
$child.StartInfo = $info
$peak = [long]0
$samples = 0
$maxGapMs = 0.0
$watch = [Diagnostics.Stopwatch]::StartNew()
$null = $child.Start()
$stdoutTask = $child.StandardOutput.ReadToEndAsync()
$stderrTask = $child.StandardError.ReadToEndAsync()
$previousSampleMs = $watch.Elapsed.TotalMilliseconds
while (-not $child.HasExited) {
  $child.Refresh()
  try {
    $peak = [Math]::Max($peak, $child.PeakWorkingSet64)
    $samples++
    $nowMs = $watch.Elapsed.TotalMilliseconds
    $maxGapMs = [Math]::Max($maxGapMs, $nowMs - $previousSampleMs)
    $previousSampleMs = $nowMs
  } catch [System.InvalidOperationException] { }
  $null = $child.WaitForExit(1)
}
$watch.Stop()
$child.WaitForExit()
$result = [ordered]@{
  exitCode = $child.ExitCode; wallMs = $watch.Elapsed.TotalMilliseconds
  peakRssBytes = $peak; rssSamples = $samples; maxRssSampleGapMs = $maxGapMs
  stdout = $stdoutTask.Result; stderr = $stderrTask.Result
}
$child.Dispose()
$result | ConvertTo-Json -Compress
`);
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { min: sorted[0], median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 };
}

try {
  assert.equal(process.argv.length, 4, 'Usage: npm run benchmark -- <snapshot-A> <snapshot-B> (each containing src/)');
  assert.equal(process.platform, 'win32', 'The external RSS monitor currently requires Windows');
  const variants = ['A', 'B'].map((name, index) => {
    const directory = path.resolve(process.argv[index + 2]);
    return { name, directory, sourceHashes: Object.fromEntries(sourceFiles.map((file) => [file, hashFile(path.join(directory, file))])) };
  });
  const hardware = powershell(`
$cpuInfo = @(Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors)
$diskInfo = @(Get-Partition -DriveLetter ${quotePS(path.parse(root).root[0])} | Get-Disk | Select-Object Number, FriendlyName, BusType)
$physical = @(Get-PhysicalDisk | Select-Object FriendlyName, MediaType, BusType)
$plan = (& powercfg.exe /getactivescheme | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot read the active power scheme' }
$settings = (& powercfg.exe /query | Out-String).Trim()
[ordered]@{ cpu = $cpuInfo; volumeDisks = $diskInfo; physicalDisks = $physical; powerScheme = $plan; powerSettings = $settings } | ConvertTo-Json -Depth 5 -Compress
`);
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'outputs/baseline-hashes-1-5.json'), 'utf8').replace(/^\uFEFF/, ''));
  const firstSix = JSON.parse(fs.readFileSync(path.join(root, 'outputs/baseline-hash-6.json'), 'utf8').replace(/^\uFEFF/, ''));
  const expected = new Map([...baseline, firstSix].map((entry) => [entry.dataset, entry.sha256]));
  const report = {
    createdAt: new Date().toISOString(), node: process.version, platform: `${os.platform()} ${os.release()}`,
    hardware, variants, repetitionsPerVersion: repetitions,
    method: {
      order: 'Ten adjacent pairs, AB/BA alternating; ten measured fresh Node processes per version on dataset 6',
      warm: 'Streaming preload of the same input before every execution; no RAMMap or cache eviction',
      wall: 'External monotonic Stopwatch from Process.Start through exit, including Node startup; setup and preload excluded',
      phases: 'hrtime.bigint; parseAndGroup includes scanning, validation and grouping; detection overlaps sortAndScan and haversineAndClassification',
      rss: 'External PeakWorkingSet64 polling with WaitForExit(1); possible lower bound if final peak is missed; native maxRSS also recorded',
      warmup: 'One full dataset-6 process per version excluded from statistics; datasets 1-5 also validated before measurement',
    }, inputs: [], validations: [], warmups: [], samples: [], summaries: [],
  };
  const reportPath = path.join(root, `outputs/benchmark-ab-${report.createdAt.replaceAll(/[:.]/g, '-')}.json`);

  function run(variant, dataset) {
    const input = path.join(root, `data/dataset${dataset}.txt`);
    const output = path.join(root, `outputs/dataset${dataset}.json`);
    warmCache(input);
    const result = measure(path.join(variant.directory, 'src/cli.js'), input, output);
    assert.equal(result.exitCode, 0, result.stderr);
    const summary = result.stderr.split('\n').find((line) => line.startsWith('Summary: '));
    assert.ok(summary, 'CLI summary missing');
    const stats = JSON.parse(summary.slice('Summary: '.length));
    assert.equal(stats.rejectedRecords, 0);
    assert.ok(!fs.existsSync(`${output}.rejects.jsonl`));
    assert.equal(Object.values(stats.encounters).reduce((sum, count) => sum + count, 0), counts[dataset - 1]);
    const sha256 = hashFile(output);
    assert.equal(sha256, expected.get(dataset), `Dataset ${dataset} output hash changed`);
    assert.ok(result.peakRssBytes > 0, 'External RSS measurement missing');
    return { version: variant.name, dataset, sha256, ...result, stats };
  }

  for (let dataset = 1; dataset <= 6; dataset++) {
    const input = path.join(root, `data/dataset${dataset}.txt`);
    report.inputs.push({ dataset, bytes: fs.statSync(input).size, sha256: hashFile(input) });
  }
  for (const variant of variants) {
    for (let dataset = 1; dataset <= 5; dataset++) report.validations.push(run(variant, dataset));
    report.warmups.push(run(variant, 6));
    console.log(`Version ${variant.name}: datasets 1-6 validated; warmup complete; all hashes match`);
  }
  for (let pair = 1; pair <= repetitions; pair++) {
    const order = pair % 2 ? variants : [...variants].reverse();
    for (const variant of order) {
      const sample = { pair, ...run(variant, 6) };
      report.samples.push(sample);
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`Pair ${pair}/${repetitions} ${variant.name}: ${sample.wallMs.toFixed(2)} ms, ${(sample.peakRssBytes / 1048576).toFixed(2)} MiB; hash matches`);
    }
  }
  report.powerSchemeAfter = powershell('(& powercfg.exe /getactivescheme | Out-String).Trim() | ConvertTo-Json -Compress');
  assert.equal(report.powerSchemeAfter, hardware.powerScheme, 'Power scheme changed during benchmark');
  for (const variant of variants) {
    for (const file of sourceFiles) assert.equal(hashFile(path.join(variant.directory, file)), variant.sourceHashes[file], 'Snapshot changed during benchmark');
    const samples = report.samples.filter((sample) => sample.version === variant.name);
    report.summaries.push({
      version: variant.name, wallMs: summarize(samples.map((sample) => sample.wallMs)),
      peakRssBytes: summarize(samples.map((sample) => sample.peakRssBytes)),
      maxPeakRssBytes: Math.max(...samples.map((sample) => sample.peakRssBytes)),
      timingsMs: Object.fromEntries(Object.keys(samples[0].stats.timingsMs)
        .map((phase) => [phase, summarize(samples.map((sample) => sample.stats.timingsMs[phase]))])),
      cpuMs: summarize(samples.map((sample) => sample.stats.cpuMs.user + sample.stats.cpuMs.system)),
    });
  }
  report.pairedWallRatio = summarize(Array.from({ length: repetitions }, (_, index) => {
    const samples = report.samples.filter((sample) => sample.pair === index + 1);
    return samples.find((sample) => sample.version === 'B').wallMs / samples.find((sample) => sample.version === 'A').wallMs;
  }));
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.table(report.summaries.map((entry) => ({
    version: entry.version, minMs: entry.wallMs.min.toFixed(2), medianMs: entry.wallMs.median.toFixed(2),
    parseMedianMs: entry.timingsMs.parseAndGroup.median.toFixed(2), scanMedianMs: entry.timingsMs.sortAndScan.median.toFixed(2),
    peakMedianMiB: (entry.peakRssBytes.median / 1048576).toFixed(2),
  })));
  console.log(`Median paired B/A wall ratio: ${report.pairedWallRatio.median.toFixed(4)}; report: ${reportPath}`);
} catch (error) {
  console.error(`Benchmark failed: ${error.message}`);
  process.exitCode = 1;
}
