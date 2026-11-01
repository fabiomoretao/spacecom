import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const repetitions = 5;
const rammap = path.join(root, 'outputs/benchmark-tools/RAMMap64.exe');
const counts = [4, 6, 10, 15, 21, 27];
const quotePS = (value) => `'${value.replaceAll("'", "''")}'`;

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
  try { while (fs.readSync(fd, buffer, 0, buffer.length, null)) { /* Preload outside measurement. */ } }
  finally { fs.closeSync(fd); }
}

function measure(input, output, cold) {
  // The external monitor samples the OS lifetime peak, not the instantaneous RSS.
  return powershell(`
${cold ? `foreach ($mode in @('-Es', '-Et')) {
  $clear = Start-Process -FilePath ${quotePS(rammap)} -ArgumentList @('-accepteula', $mode) -WindowStyle Hidden -PassThru -Wait
  if ($clear.ExitCode -ne 0) { throw "RAMMap failed: $mode, exit $($clear.ExitCode)" }
}` : ''}
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = ${quotePS(process.execPath)}
$info.Arguments = ${quotePS(`"${path.join(root, 'src/cli.js')}" "${input}" "${output}"`)}
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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

try {
  assert.equal(process.argv.length, 2, 'Benchmark has no command-line options');
  assert.equal(process.platform, 'win32', 'External RSS and cache control currently require Windows');
  assert.ok(fs.existsSync(rammap), 'Install the authorized Microsoft RAMMap in outputs/benchmark-tools first');
  const hardware = powershell(`
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run benchmark from an elevated terminal for cold-cache measurements' }
$signature = Get-AuthenticodeSignature -LiteralPath ${quotePS(rammap)}
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*O=Microsoft Corporation*') { throw 'RAMMap signature is not valid Microsoft code' }
$cpuInfo = @(Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors)
$diskInfo = @(Get-Partition -DriveLetter ${quotePS(path.parse(root).root[0])} | Get-Disk | Select-Object Number, FriendlyName, BusType)
$physical = @(Get-PhysicalDisk | Select-Object FriendlyName, MediaType, BusType)
[ordered]@{ cpu = $cpuInfo; volumeDisks = $diskInfo; physicalDisks = $physical; rammapVersion = (Get-Item -LiteralPath ${quotePS(rammap)}).VersionInfo.FileVersion } | ConvertTo-Json -Depth 5 -Compress
`);
  const baselinePath = path.join(root, 'outputs/baseline-hashes-1-5.json');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8').replace(/^\uFEFF/, ''));
  const expected = new Map(baseline.map((entry) => [entry.dataset, entry.sha256]));
  const firstSixPath = path.join(root, 'outputs/baseline-hash-6.json');
  const firstSix = JSON.parse(fs.readFileSync(firstSixPath, 'utf8').replace(/^\uFEFF/, ''));
  expected.set(6, firstSix.sha256);
  const sourceFiles = ['src/io/read-groups.js', 'src/domain/find-encounters.js',
    'src/process-dataset.js', 'src/cli.js', 'scripts/benchmark.js'];
  const report = {
    createdAt: new Date().toISOString(), node: process.version, platform: `${os.platform()} ${os.release()}`,
    hardware, repetitions, sourceHashes: Object.fromEntries(sourceFiles.map((file) => [file, hashFile(path.join(root, file))])),
    method: {
      phases: 'hrtime.bigint; parseAndGroup includes line scanning, validation and grouping; sortAndScan excludes timed candidate evaluation; detection overlaps its two subphases',
      wall: 'External PowerShell Stopwatch from Process.Start through exit, including Node startup; monitor setup and cache preparation excluded',
      rss: 'External polling of OS PeakWorkingSet64 with WaitForExit(1); lower bound if the peak occurs after the final sample; internal maxRSS recorded for comparison',
      cold: 'Elevated Microsoft RAMMap -Es then -Et immediately before each child; OS file cache only, SSD/controller cache is not flushed',
      warm: 'Full streaming read of the same input immediately before each child; each child is a fresh Node process',
      order: 'Five cold/warm pairs per dataset, datasets 1 through 6; no concurrent benchmark runs',
    }, inputs: [], samples: [], medians: [],
  };
  const reportPath = path.join(root, `outputs/benchmark-${report.createdAt.replaceAll(/[:.]/g, '-')}.json`);
  for (let dataset = 1; dataset <= 6; dataset++) {
    const input = path.join(root, `data/dataset${dataset}.txt`);
    const output = path.join(root, `outputs/dataset${dataset}.json`);
    assert.equal(hashFile(output), expected.get(dataset), `Dataset ${dataset} output differs from baseline before benchmark`);
    report.inputs.push({ dataset, bytes: fs.statSync(input).size, sha256: hashFile(input) });
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const cache of ['cold', 'warm']) {
        if (cache === 'warm') warmCache(input);
        const result = measure(input, output, cache === 'cold');
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
        report.samples.push({ dataset, repetition, cache, sha256, ...result, stats });
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        console.log(`Dataset ${dataset} ${cache} ${repetition}/${repetitions}: ${result.wallMs.toFixed(2)} ms, ${(result.peakRssBytes / 1048576).toFixed(2)} MiB; hash matches`);
      }
    }
    for (const cache of ['cold', 'warm']) {
      const samples = report.samples.filter((sample) => sample.dataset === dataset && sample.cache === cache);
      report.medians.push({
        dataset, cache,
        wallMs: median(samples.map((sample) => sample.wallMs)),
        peakRssBytes: median(samples.map((sample) => sample.peakRssBytes)),
        maxPeakRssBytes: Math.max(...samples.map((sample) => sample.peakRssBytes)),
        timingsMs: Object.fromEntries(Object.keys(samples[0].stats.timingsMs)
          .map((phase) => [phase, median(samples.map((sample) => sample.stats.timingsMs[phase]))])),
        cpuMs: median(samples.map((sample) => sample.stats.cpuMs.user + sample.stats.cpuMs.system)),
      });
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  }
  console.table(report.medians.map((entry) => ({
    dataset: entry.dataset, cache: entry.cache, totalMs: entry.wallMs.toFixed(2),
    readMs: entry.timingsMs.read.toFixed(2), parseMs: entry.timingsMs.parseAndGroup.toFixed(2),
    scanMs: entry.timingsMs.sortAndScan.toFixed(2), evaluateMs: entry.timingsMs.haversineAndClassification.toFixed(2),
    writeMs: entry.timingsMs.write.toFixed(2), peakMiB: (entry.peakRssBytes / 1048576).toFixed(2),
  })));
  console.log(`Report: ${reportPath}`);
} catch (error) {
  console.error(`Benchmark failed: ${error.message}`);
  process.exitCode = 1;
}
