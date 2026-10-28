/** Read-only source fixture: migrate a copy of a real saved catalogue, never RUNs. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const source = path.resolve(process.argv[2] || 'workflows/workflows.json');
const original = await fs.readFile(source);
const originalRows = JSON.parse(original.toString('utf-8'));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-catalogue-upgrade-'));
process.env.TRACE_APP_ROOT = process.cwd();
process.env.TRACE_DATA_ROOT = temporary;
await fs.mkdir(path.join(temporary, 'workflows'), { recursive: true });
await fs.writeFile(path.join(temporary, 'workflows', 'workflows.json'), original);
const store = await import('../server/workflows/workflowStore');
store.enableRequestedCatalogueCleanup();
const rows = await store.loadWorkflows();
for (const id of store.REQUESTED_KEEP_IDS) assert.equal(rows.find(w => w.id === id)?.lifecycle?.state, 'active');
for (const id of store.REQUESTED_REMOVE_IDS) assert(!rows.some(w => w.id === id));
assert(!rows.some(w => w.lifecycle?.state === 'pending_disposal'));
for (const row of originalRows) if (row.lifecycle?.state === 'pending_disposal' && !store.REQUESTED_KEEP_IDS.has(row.id)) assert(!rows.some(w => w.id === row.id));
assert(rows.some(w => w.id === 'encode-hic'));
assert(rows.some(w => w.id === 'encode-eclip'));
const marker = JSON.parse(await fs.readFile(path.join(temporary, 'workflows', '.catalogue-cleanup-v0.5.16.json'), 'utf-8'));
assert((await fs.readFile(path.join(marker.backupDir, 'original-catalogue.json'))).equals(original));
assert((await fs.readFile(source)).equals(original), 'The source catalogue changed during the read-only verification');
console.log(JSON.stringify({ originalDefinitions: originalRows.length, activeDefinitionsAfterUpgrade: rows.length,
  removedOriginalDefinitions: originalRows.filter((w: any) => !rows.some(row => row.id === w.id)).length,
  retained: [...store.REQUESTED_KEEP_IDS], pendingAfterUpgrade: 0, sourceUnmodified: true, evidenceDirectory: temporary }, null, 2));
