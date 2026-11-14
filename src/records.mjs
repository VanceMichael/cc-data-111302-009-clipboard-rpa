import {mkdir, readFile, readdir, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

export function assertRecordId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw Object.assign(new Error('记录编号不合法'), {status: 400});
  return id;
}

export function createRecordStore(directory) {
  const ready = mkdir(directory, {recursive: true});
  const pathFor = id => join(directory, `${assertRecordId(id)}.json`);
  return {
    directory,
    async save(record) {
      await ready;
      const path = pathFor(record.id);
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(record, null, 2));
      await rename(temporary, path);
    },
    async load(id) {
      await ready;
      try {
        return JSON.parse(await readFile(pathFor(id), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async exists(id) {
      return (await this.load(id)) !== null;
    },
    async list() {
      await ready;
      const entries = await readdir(directory);
      const records = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
          records.push(JSON.parse(await readFile(join(directory, entry), 'utf8')));
        } catch {}
      }
      return records.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    }
  };
}

export function summarizeRecord(record) {
  return {
    id: record.id,
    product: record.product,
    title: record.productTitle ?? null,
    accountant: record.accountant,
    status: record.status,
    phase: record.phase,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    copy: record.copy
      ? {
          sourcePage: record.copy.sourcePage,
          sourceUrl: record.copy.sourceUrl,
          product: record.copy.product,
          version: record.copy.version,
          token: record.copy.token,
          copiedAt: record.copy.copiedAt
        }
      : null,
    clipboardVerified: record.clipboard?.verified ?? false,
    adoptedRepresentation: record.paste?.adopted ?? record.clipboard?.adopted ?? null,
    settle: record.cleanup?.settled ?? false,
    readback: record.readback
      ? {
          title: record.readback.title,
          paragraphs: record.readback.paragraphs,
          links: record.readback.links,
          tables: record.readback.tables,
          images: record.readback.images.length,
          unsupported: record.readback.unsupported,
          settled: record.readback.settled
        }
      : null,
    confirmations: record.confirmations ?? [],
    issues: record.issues ?? [],
    humanReviewRequired: record.humanReviewRequired ?? false,
    handover: record.handover ?? null
  };
}
