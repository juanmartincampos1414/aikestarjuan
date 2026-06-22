import { randomUUID } from 'crypto';

interface TrashEntry {
  entityType: string;
  entityId: string;
  data: any;
  organizationId: string;
  userId: string;
  deletedAt: Date;
  timer: ReturnType<typeof setTimeout>;
}

const trashBin = new Map<string, TrashEntry>();

const EXPIRY_MS = 60_000;

export function stashForUndo(
  entityType: string,
  entityId: string,
  data: any,
  organizationId: string,
  userId: string,
): string {
  const undoKey = `${entityType}:${entityId}:${randomUUID().slice(0, 8)}`;

  const timer = setTimeout(() => {
    trashBin.delete(undoKey);
  }, EXPIRY_MS);

  trashBin.set(undoKey, {
    entityType,
    entityId,
    data,
    organizationId,
    userId,
    deletedAt: new Date(),
    timer,
  });

  return undoKey;
}

export function updateStashData(undoKey: string, updater: (data: any) => any): void {
  const entry = trashBin.get(undoKey);
  if (entry) {
    entry.data = updater(entry.data);
  }
}

export function retrieveForUndo(
  undoKey: string,
): { entityType: string; entityId: string; data: any; organizationId: string; userId: string } | null {
  const entry = trashBin.get(undoKey);
  if (!entry) return null;

  clearTimeout(entry.timer);
  trashBin.delete(undoKey);

  return {
    entityType: entry.entityType,
    entityId: entry.entityId,
    data: entry.data,
    organizationId: entry.organizationId,
    userId: entry.userId,
  };
}
