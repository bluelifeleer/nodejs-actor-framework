import fs from 'node:fs';
import fsp from 'fs/promises';
import path from 'node:path';
import _file_store from '../packages/core/src/store/backends/file-store.js';
const { FileStore } = _file_store;
import _level_store from '../packages/core/src/store/backends/level-store.js';
const { LevelStore, isAvailable } = _level_store;

/**
 * Migrate persisted actor state between store backends (file -> level today).
 *
 * Safety properties, in order of importance:
 *  1. The source is only purged after every message has been re-read from the
 *     target and matched by message id.
 *  2. Purge renames the source log to `<name>.migrated` instead of deleting it.
 *  3. Re-running is idempotent: messages already present in the target are
 *     skipped, because the target derives its keys from an append sequence and
 *     re-inserting would duplicate them.
 *  4. `--dry-run` reports what would happen without writing anything.
 *
 * Usage:
 *   node tools/migrate-store.js --data ./data [--actor id]... [--purge] [--dry-run] [--json]
 */








function parseArgs(argv) {
  const options = { dataDir: null, actors: [], purge: false, dryRun: false, json: false, levelPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--data' || arg === '-d') options.dataDir = argv[++i];
    else if (arg === '--level') options.levelPath = argv[++i];
    else if (arg === '--actor' || arg === '-a') options.actors.push(argv[++i]);
    else if (arg === '--purge') options.purge = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const HELP = `Usage: node tools/migrate-store.js --data <dir> [options]

Moves persisted actor messages from the file backend (default) to LevelDB.

Options:
  -d, --data <dir>     data directory containing msg_store/ (required)
      --level <dir>    LevelDB root (default: <data>/level)
  -a, --actor <id>     migrate only this actor (repeatable; default: all in manifest)
      --purge          rename migrated source logs to *.migrated
      --dry-run        report without writing
      --json           machine-readable summary
  -h, --help           this message

Exit codes: 0 success, 1 failure or verification mismatch.
`;

/**
 * @param {{dataDir:string, levelPath?:string, actors?:string[], purge?:boolean,
 *          dryRun?:boolean, onProgress?:(event:object)=>void}} options
 */
async function migrate(options) {
  if (!options || !options.dataDir) throw new Error('dataDir is required');
  const dataDir = path.resolve(options.dataDir);
  const sourceDir = path.join(dataDir, 'msg_store');
  const levelRoot = path.resolve(options.levelPath || path.join(dataDir, 'level'));

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`no file-backend data at ${sourceDir}`);
  }

  const source = new FileStore({ baseDir: sourceDir });
  const manifest = await source.listActors();

  let actorIds = options.actors && options.actors.length > 0 ? [...options.actors] : manifest.map((e) => e.actorId);
  if (actorIds.length === 0) {
    actorIds = await inferActorsFromFiles(sourceDir);
    if (actorIds.length > 0) {
      options.onProgress?.({
        type: 'warning',
        message:
          'no manifest found; falling back to filenames, which cannot recover actor ids. ' +
          'Pass --actor explicitly for a reliable migration.',
      });
    }
  }
  if (actorIds.length === 0) throw new Error('nothing to migrate: no actors found');

  const availability = isAvailable();
  if (!availability.available && !options.dryRun) throw new Error(availability.reason);

  // Constructing the backend creates its directory, so a dry run must not do it.
  const target = !options.dryRun && availability.available ? new LevelStore({ root: levelRoot }) : null;
  const summary = { dataDir, levelRoot, dryRun: Boolean(options.dryRun), purge: Boolean(options.purge), actors: [] };

  try {
    for (const actorId of actorIds) {
      const messages = await source.load(actorId);
      const entry = { actorId, messages: messages.length, migrated: 0, skipped: 0, verified: false, purged: false };

      if (messages.length === 0) {
        summary.actors.push(entry);
        options.onProgress?.({ type: 'actor', ...entry });
        continue;
      }

      if (!options.dryRun) {
        const existing = new Set((await target.load(actorId)).map((m) => m.__msgId));
        for (const message of messages) {
          if (existing.has(message.__msgId)) {
            entry.skipped += 1;
            continue;
          }
          await target.append(actorId, message);
          entry.migrated += 1;
        }

        // Verify by message id before touching the source.
        const written = await target.load(actorId);
        const writtenIds = new Set(written.map((m) => m.__msgId));
        const missing = messages.filter((m) => !writtenIds.has(m.__msgId));
        if (missing.length > 0) {
          throw new Error(
            `verification failed for ${actorId}: ${missing.length} of ${messages.length} messages are missing in ${levelRoot}`,
          );
        }
        entry.verified = true;
        entry.totalInTarget = written.length;

        if (options.purge) {
          const from = source.pathFor(actorId);
          if (fs.existsSync(from)) {
            await fsp.rename(from, `${from}.migrated`);
            entry.purged = true;
          }
        }
      }

      summary.actors.push(entry);
      options.onProgress?.({ type: 'actor', ...entry });
    }

    summary.ok = true;
    summary.totals = summary.actors.reduce(
      (acc, a) => ({
        messages: acc.messages + a.messages,
        migrated: acc.migrated + a.migrated,
        skipped: acc.skipped + a.skipped,
        purged: acc.purged + (a.purged ? 1 : 0),
      }),
      { messages: 0, migrated: 0, skipped: 0, purged: 0 },
    );
    return summary;
  } finally {
    await source.close();
    if (target) await target.close();
  }
}

/**
 * Without a manifest the actor id cannot be recovered from a hashed filename.
 * Return the raw file stems so the caller can see something is there, and let
 * the operator pass --actor explicitly.
 */
async function inferActorsFromFiles(sourceDir) {
  const files = await fsp.readdir(sourceDir).catch(() => []);
  return files
    .filter((f) => f.endsWith('.log'))
    .map((f) => f.replace(/\.log$/, ''))
    .filter(Boolean);
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error(HELP);
    return 1;
  }
  if (options.help || !options.dataDir) {
    console.log(HELP);
    return options.help ? 0 : 1;
  }

  try {
    const summary = await migrate({
      ...options,
      onProgress: options.json
        ? undefined
        : (event) => {
            if (event.type === 'warning') console.warn(`[warn] ${event.message}`);
            else if (event.type === 'actor' && event.messages > 0) {
              console.log(
                `  ${event.actorId}: ${event.messages} message(s)` +
                  (options.dryRun
                    ? ''
                    : `, migrated ${event.migrated}, skipped ${event.skipped}${event.purged ? ', source renamed' : ''}`),
              );
            }
          },
    });

    if (options.json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(
        `${summary.dryRun ? '[dry-run] ' : ''}${summary.totals.messages} message(s) across ` +
          `${summary.actors.length} actor(s); migrated ${summary.totals.migrated}, skipped ${summary.totals.skipped}` +
          `${summary.purge ? `, purged ${summary.totals.purged}` : ''}`,
      );
      if (!summary.dryRun) console.log(`level data: ${summary.levelRoot}`);
    }
    return 0;
  } catch (err) {
    console.error(`migration failed: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] === import.meta.filename) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

export { migrate, parseArgs, inferActorsFromFiles, main, HELP };
export default { migrate, parseArgs, inferActorsFromFiles, main, HELP };
