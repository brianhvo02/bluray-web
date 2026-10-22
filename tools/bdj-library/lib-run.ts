/**
 * The libbluray side's command line (tools/bdj-trace/run.sh --keys), as check.ts runs it. No process access.
 */

/** The run's limits, the same on both sides (tools/bdj-library/README.md). */
export interface LibRunLimits {
  readonly seconds: number;
  readonly waitTimeout: number;
  readonly tail: number;
}

/**
 * run.sh's arguments for one attempt on one disc. Attempt 2 is the retry of a crashed run: HotSpot under amd64
 * emulation can die with a SIGSEGV in libzip (ZipFile.getEntry on mapped memory) on every run of some discs, and
 * without memory-mapped zip directories it does not; the option changes nothing else.
 */
export function libRunArgs(runSh: string, disc: string, script: string, limits: LibRunLimits, attempt: number, name: string): string[] {
  return [
    runSh, disc, '--keys', script, '--seconds', String(limits.seconds), '--wait-timeout', String(limits.waitTimeout), '--tail', String(limits.tail),
    ...(attempt > 1 ? ['--jvm-option', '-Dsun.zip.disableMemoryMapping=true'] : []),
    '--name', name,
  ];
}
