import type { Express } from "express";
import { storage } from "../storage";
import { insertAccountSchema, ROLE_PERMISSIONS, type Role, accounts, transactions, clients, suppliers, products, stockMovements, auditLogs, isCancellationEntry, invoiceNumberChangeError } from "@shared/schema";
import { parseTransactionInsertBody, parseTransactionUpdateBody, respondIfInvalid } from "./transactionValidation";
import { validateTransactionCategory } from "../services/categoryValidation";
import { z } from "zod";
import { requireAuth, requirePermission, sanitizeError } from "./middleware";
import { stashForUndo, retrieveForUndo, updateStashData } from "../services/undoTrash";
import { db } from "../db";
import { and, eq, inArray, sql, asc } from "drizzle-orm";
import { autoApplyPaymentToCommitments } from "../services/autoApply";
import { deriveStockLines, adjustStockForLines, type StockLine } from "../lib/transactionStock";

// Task #475: optional multi-product line items accepted by POST /api/transactions.
// Only used when 2+ distinct products are sent; 0/1 product keeps the legacy
// productId/productQuantity fields. Quantities/prices arrive as numbers/strings.
const transactionItemInputSchema = z.object({
  productId: z.string().min(1),
  quantity: z.union([z.string(), z.number()]),
  unitPrice: z.union([z.string(), z.number()]),
  description: z.string().nullable().optional(),
  profitabilityCodeId: z.string().nullable().optional(),
});
const transactionItemsInputSchema = z.array(transactionItemInputSchema);

function parseValidQuantity(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = parseFloat(String(value));
  if (isNaN(num) || num <= 0) return null;
  return num;
}

// El WAF del borde del deploy (Google Cloud Armor, regla OWASP CRS 933150)
// bloquea cualquier body que contenga la subcadena `settype` (case-insensitive,
// porque `settype` es una función PHP de alto riesgo). La clave `assetType` la
// contiene, así que el cliente la manda como `asset_type` para esquivar el WAF.
// Acá la volvemos a `assetType` antes de validar/persistir. Acepta ambos nombres
// por compatibilidad (clientes viejos que aún manden `assetType` no se rompen).
function normalizeAssetTypeKey(body: any): any {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  if (!('asset_type' in body)) return body;
  const { asset_type, ...rest } = body;
  return { ...rest, assetType: asset_type };
}

export function registerTransactionRoutes(app: Express): void {
  // Account routes
  app.get('/api/accounts', requireAuth, async (req: any, res) => {
    try {
      const accounts = await storage.getAccountsByOrganization(req.organizationId);
      res.json(accounts);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  app.post('/api/accounts', requireAuth, requirePermission('accounts:create'), async (req: any, res) => {
    try {
      const membership = await storage.getMembershipByUserAndOrg(req.userId, req.organizationId);
      if (!membership) {
        return res.status(403).json({ message: 'No tenés acceso a esta organización' });
      }
      const permissions = ROLE_PERMISSIONS[membership.role as Role] || [];
      if (!permissions.includes('accounts:create')) {
        return res.status(403).json({ message: 'No tenés permiso para crear cuentas' });
      }
      
      const data = insertAccountSchema.parse(req.body);
      const account = await storage.createAccount({
        ...data,
        organizationId: req.organizationId,
      });
      
      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'account',
        entityId: account.id,
        action: 'create',
        previousData: null,
        newData: JSON.stringify(account),
      });
      
      res.json(account);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: 'Validation error', errors: error.errors });
      }
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  app.patch('/api/accounts/:id', requireAuth, requirePermission('accounts:edit'), async (req: any, res) => {
    try {
      const membership = await storage.getMembershipByUserAndOrg(req.userId, req.organizationId);
      if (!membership) {
        return res.status(403).json({ message: 'No tenés acceso a esta organización' });
      }
      const permissions = ROLE_PERMISSIONS[membership.role as Role] || [];
      if (!permissions.includes('accounts:edit')) {
        return res.status(403).json({ message: 'No tenés permiso para editar cuentas' });
      }
      
      const { id } = req.params;
      
      const previousAccount = await storage.getAccount(id);
      if (!previousAccount || previousAccount.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Account not found' });
      }
      
      const { updateAccountSchema } = await import('@shared/schema');
      const { balance, ...bodyWithoutBalance } = req.body;
      const parseResult = updateAccountSchema.safeParse(bodyWithoutBalance);
      if (!parseResult.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: parseResult.error.errors });
      }
      
      const account = await storage.updateAccount(id, parseResult.data);
      if (!account) {
        return res.status(404).json({ message: 'Account not found' });
      }
      
      if (previousAccount) {
        await storage.createAuditLog({
          organizationId: req.organizationId,
          userId: req.userId,
          entityType: 'account',
          entityId: id,
          action: 'update',
          previousData: JSON.stringify(previousAccount),
          newData: JSON.stringify(account),
        });
      }
      
      res.json(account);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  app.delete('/api/accounts/:id', requireAuth, requirePermission('accounts:delete'), async (req: any, res) => {
    try {
      const membership = await storage.getMembershipByUserAndOrg(req.userId, req.organizationId);
      if (!membership) {
        return res.status(403).json({ message: 'No tenés acceso a esta organización' });
      }
      const permissions = ROLE_PERMISSIONS[membership.role as Role] || [];
      if (!permissions.includes('accounts:delete')) {
        return res.status(403).json({ message: 'No tenés permiso para eliminar cuentas' });
      }
      
      const { id } = req.params;
      const action = req.query.action as string | undefined;
      const targetAccountId = req.query.targetAccountId as string | undefined;
      
      const accountToDelete = await storage.getAccount(id);
      if (!accountToDelete || accountToDelete.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Cuenta no encontrada' });
      }
      
      const balance = parseFloat(accountToDelete.balance.toString());
      const now = new Date();
      
      if (balance !== 0) {
        if (action === 'transfer' && targetAccountId) {
          const targetAccount = await storage.getAccount(targetAccountId);
          if (!targetAccount || targetAccount.organizationId !== req.organizationId) {
            return res.status(404).json({ message: 'La cuenta destino no fue encontrada' });
          }
          
          if (targetAccount.currency !== accountToDelete.currency) {
            return res.status(400).json({ message: 'No se puede transferir entre cuentas de distinta moneda al eliminar. Elegí una cuenta en la misma moneda.' });
          }
          
          const absBalance = Math.abs(balance);
          const transferDesc = `Transferencia por cierre de cuenta "${accountToDelete.name}"`;
          
          const transferPairId = crypto.randomUUID();
          
          if (balance > 0) {
            await storage.createTransaction({
              type: 'transfer_out',
              amount: absBalance.toString(),
              description: transferDesc,
              category: 'Transferencia',
              date: now,
              imputationDate: now,
              accountId: id,
              organizationId: req.organizationId,
              createdBy: req.userId,
              status: 'completed',
              completedBy: req.userId,
              completedAt: now,
              hasInvoice: false,
              invoiceType: null,
              invoiceNumber: null,
              invoiceTaxId: null,
              invoiceFileUrl: null,
              transferPairId,
            });
            
            await storage.createTransaction({
              type: 'transfer_in',
              amount: absBalance.toString(),
              description: transferDesc,
              category: 'Transferencia',
              date: now,
              imputationDate: now,
              accountId: targetAccountId,
              organizationId: req.organizationId,
              createdBy: req.userId,
              status: 'completed',
              completedBy: req.userId,
              completedAt: now,
              hasInvoice: false,
              invoiceType: null,
              invoiceNumber: null,
              invoiceTaxId: null,
              invoiceFileUrl: null,
              transferPairId,
            });
          } else {
            await storage.createTransaction({
              type: 'transfer_in',
              amount: absBalance.toString(),
              description: transferDesc,
              category: 'Transferencia',
              date: now,
              imputationDate: now,
              accountId: id,
              organizationId: req.organizationId,
              createdBy: req.userId,
              status: 'completed',
              completedBy: req.userId,
              completedAt: now,
              hasInvoice: false,
              invoiceType: null,
              invoiceNumber: null,
              invoiceTaxId: null,
              invoiceFileUrl: null,
              transferPairId,
            });
            
            await storage.createTransaction({
              type: 'transfer_out',
              amount: absBalance.toString(),
              description: transferDesc,
              category: 'Transferencia',
              date: now,
              imputationDate: now,
              accountId: targetAccountId,
              organizationId: req.organizationId,
              createdBy: req.userId,
              status: 'completed',
              completedBy: req.userId,
              completedAt: now,
              hasInvoice: false,
              invoiceType: null,
              invoiceNumber: null,
              invoiceTaxId: null,
              invoiceFileUrl: null,
              transferPairId,
            });
          }
          
        } else if (action === 'adjust') {
          const adjustType = balance > 0 ? 'expense' : 'income';
          const absBalance = Math.abs(balance);
          
          await storage.createTransaction({
            type: adjustType,
            amount: absBalance.toString(),
            description: `Ajuste por cierre de cuenta "${accountToDelete.name}"`,
            category: 'Cierre de cuenta',
            date: now,
            imputationDate: now,
            accountId: id,
            organizationId: req.organizationId,
            createdBy: req.userId,
            status: 'completed',
            completedBy: req.userId,
            completedAt: now,
            hasInvoice: false,
            invoiceType: null,
            invoiceNumber: null,
            invoiceTaxId: null,
            invoiceFileUrl: null,
          });
          
        } else {
          return res.status(400).json({ 
            message: 'Esta cuenta tiene saldo. Elegí si querés transferirlo o registrarlo como movimiento.',
            balance,
            requiresAction: true,
          });
        }
      }

      const deleted = await storage.deleteAccount(id);
      if (!deleted) {
        return res.status(404).json({ message: 'Cuenta no encontrada' });
      }
      
      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'account',
        entityId: id,
        action: 'delete',
        previousData: JSON.stringify(accountToDelete),
        newData: null,
      });
      
      res.json({ message: 'Cuenta eliminada' });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/undo-delete', requireAuth, async (req: any, res) => {
    try {
      const { undoKey } = req.body;
      if (!undoKey) {
        return res.status(400).json({ message: 'undoKey es requerido' });
      }

      const entry = retrieveForUndo(undoKey);
      if (!entry) {
        return res.status(404).json({ message: 'Ya no se puede deshacer esta acción' });
      }

      if (entry.organizationId !== req.organizationId) {
        return res.status(403).json({ message: 'No tenés acceso a este registro' });
      }

      const { entityType, entityId, data } = entry;

      try {
        switch (entityType) {
          case 'account':
            await db.insert(accounts).values(data);
            break;
          case 'transaction': {
            const { _cancellationId, _pairedTransaction, _pairedCancellationId, _items, ...txData } = data;

            await db.transaction(async (tx) => {
              await tx.insert(transactions).values(txData);
              console.log(`[UNDO] Restored transaction id=${txData.id} type=${txData.type} amount=${txData.amount}`);

              if (_cancellationId) {
                const deleted = await tx.delete(transactions).where(eq(transactions.id, _cancellationId)).returning();
                if (deleted.length === 0) {
                  console.warn(`[UNDO] Cancellation record id=${_cancellationId} not found — already removed, proceeding`);
                } else {
                  console.log(`[UNDO] Deleted cancellation record id=${_cancellationId}`);
                }
              } else if (txData.status === 'completed') {
                const orphanedCancellations = await tx.select().from(transactions).where(
                  and(
                    eq(transactions.organizationId, txData.organizationId),
                    sql`${transactions.description} LIKE '[CANCELACIÓN]%'`,
                    sql`(${transactions.originalTransactionData})::jsonb->>'id' = ${txData.id}`
                  )
                );
                for (const orphan of orphanedCancellations) {
                  await tx.delete(transactions).where(eq(transactions.id, orphan.id));
                  console.log(`[UNDO] Cleaned up orphaned cancellation id=${orphan.id} for original id=${txData.id}`);
                }
              }

              if (txData.status === 'completed' && txData.accountId) {
                const amount = parseFloat(txData.amount);
                const wasPositive = txData.type === 'income' || txData.type === 'transfer_in' || txData.type === 'receivable';
                const delta = wasPositive ? amount : -amount;
                await tx.update(accounts)
                  .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) + ${delta})` })
                  .where(eq(accounts.id, txData.accountId));
                console.log(`[UNDO] Adjusted account ${txData.accountId} balance by ${delta}`);
              }

              if (_pairedTransaction) {
                const { _cancellationId: _pc, _pairedTransaction: _pt, _pairedCancellationId: _pci, ...pairedData } = _pairedTransaction;
                await tx.insert(transactions).values(pairedData);
                console.log(`[UNDO] Restored paired transaction id=${pairedData.id} type=${pairedData.type}`);

                if (_pairedCancellationId) {
                  const pDeleted = await tx.delete(transactions).where(eq(transactions.id, _pairedCancellationId)).returning();
                  if (pDeleted.length === 0) {
                    console.warn(`[UNDO] Paired cancellation id=${_pairedCancellationId} not found`);
                  }
                }

                if (pairedData.status === 'completed' && pairedData.accountId) {
                  const pAmount = parseFloat(pairedData.amount);
                  const pWasPositive = pairedData.type === 'income' || pairedData.type === 'transfer_in' || pairedData.type === 'receivable';
                  const pDelta = pWasPositive ? pAmount : -pAmount;
                  await tx.update(accounts)
                    .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) + ${pDelta})` })
                    .where(eq(accounts.id, pairedData.accountId));
                }
              }
            });

            // Recreate multi-product line items captured at delete time.
            if (Array.isArray(_items) && _items.length > 0) {
              try {
                await storage.createTransactionItems(
                  _items.map((it: any) => ({
                    transactionId: txData.id,
                    organizationId: txData.organizationId,
                    productId: it.productId,
                    description: it.description ?? null,
                    quantity: String(it.quantity),
                    unitPrice: String(it.unitPrice),
                    profitabilityCodeId: it.profitabilityCodeId ?? null,
                  })),
                );
              } catch (itemErr) {
                console.error('[UNDO] Error restoring transaction items:', itemErr);
              }
            }

            if (txData.status === 'completed') {
              try {
                const lines = deriveStockLines(
                  txData,
                  Array.isArray(_items) ? _items : undefined,
                );
                if (lines.length > 0) {
                  await adjustStockForLines({
                    lines,
                    txType: txData.type,
                    direction: 'apply',
                    organizationId: req.organizationId,
                    userId: req.userId,
                    reason: `[RESTAURACIÓN] ${txData.description || ''}`,
                  });
                }
              } catch (stockErr) {
                console.error('[Stock] Error re-applying stock on undo restore:', stockErr);
              }
            }

            if (data._autoApplyReversed && Array.isArray(data._autoApplyReversed)) {
              try {
                const entityType = txData.supplierId ? 'supplier' : txData.clientId ? 'client' : null;
                const entityId = txData.supplierId || txData.clientId;
                if (entityType && entityId && txData.status === 'completed') {
                  await autoApplyPaymentToCommitments({
                    paymentAmount: parseFloat(txData.amount),
                    currency: txData.currency || 'ARS',
                    organizationId: req.organizationId,
                    userId: req.userId,
                    entityType,
                    entityId,
                    paymentTransactionId: txData.id,
                  });
                  console.log(`[UNDO] Re-applied auto-apply for restored transaction ${txData.id}`);
                }
              } catch (reapplyErr) {
                console.error('[UNDO] Error re-applying auto-apply on restore:', reapplyErr);
              }
            }
            break;
          }
          case 'client':
            await db.insert(clients).values(data);
            break;
          case 'supplier':
            await db.insert(suppliers).values(data);
            break;
          case 'product':
            await db.insert(products).values(data);
            break;
          case 'transaction_created': {
            // T001: Reverse stock movement when undoing a completed transaction creation
            const txToUndo = await storage.getTransaction(entityId);
            if (txToUndo && txToUndo.status === 'completed') {
              try {
                const items = await storage.getTransactionItems(txToUndo.id);
                const lines = deriveStockLines(txToUndo, items);
                if (lines.length > 0) {
                  await adjustStockForLines({
                    lines,
                    txType: txToUndo.type,
                    direction: 'reverse',
                    organizationId: req.organizationId,
                    userId: req.userId,
                    reason: `[DESHACER] ${txToUndo.description || ''}`,
                  });
                }
              } catch (stockErr) {
                console.error('[Stock] Error reversing stock on undo create:', stockErr);
              }
            }
            if (txToUndo && (txToUndo.type === 'expense' || txToUndo.type === 'income') && txToUndo.status === 'completed') {
              try {
                const autoAppliedLogs = await db.select().from(auditLogs).where(
                  and(
                    eq(auditLogs.organizationId, req.organizationId),
                    eq(auditLogs.entityType, 'transaction'),
                    sql`${auditLogs.action} IN ('auto_apply_complete', 'auto_apply_partial')`,
                    sql`${auditLogs.newData}::jsonb->>'appliedByTransactionId' = ${entityId}`,
                  )
                );
                let reversedCount = 0;
                for (const log of autoAppliedLogs) {
                  const prevData = log.previousData ? JSON.parse(log.previousData) : null;
                  if (!prevData) continue;

                  const currentCommitment = await db.select().from(transactions).where(eq(transactions.id, log.entityId)).limit(1);
                  if (!currentCommitment.length) continue;
                  const curr = currentCommitment[0];

                  if (curr.autoAppliedByTransactionId !== entityId) {
                    console.log(`[UNDO Create] Skipping ${log.entityId}: autoAppliedByTransactionId=${curr.autoAppliedByTransactionId} !== ${entityId}`);
                    continue;
                  }

                  if (log.action === 'auto_apply_complete') {
                    await db.update(transactions).set({
                      status: prevData.status || 'scheduled',
                      completedBy: null,
                      completedAt: null,
                      autoAppliedByTransactionId: null,
                    }).where(eq(transactions.id, log.entityId));
                  } else if (log.action === 'auto_apply_partial') {
                    const restoredAmount = prevData.amount;
                    const wasFirstPartial = String(prevData.amount) === String(prevData.originalAmount);
                    await db.update(transactions).set({
                      amount: String(restoredAmount),
                      autoAppliedByTransactionId: null,
                      originalAmount: wasFirstPartial ? null : (prevData.originalAmount || null),
                    }).where(eq(transactions.id, log.entityId));
                  }
                  reversedCount++;
                }
                if (reversedCount > 0) {
                  console.log(`[UNDO Create] Reversed ${reversedCount} auto-applied commitments for tx ${entityId}`);
                }
              } catch (autoUndoErr) {
                console.error('[UNDO Create] Error reversing auto-apply:', autoUndoErr);
              }
            }

            await db.transaction(async (txn) => {
              if (txToUndo && txToUndo.status === 'completed' && txToUndo.accountId) {
                const amount = parseFloat(txToUndo.amount);
                const wasPositive = txToUndo.type === 'income' || txToUndo.type === 'transfer_in' || txToUndo.type === 'receivable';
                const delta = wasPositive ? -amount : amount;
                await txn.update(accounts)
                  .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) + ${delta})` })
                  .where(eq(accounts.id, txToUndo.accountId));
                console.log(`[UNDO Create] Adjusted account ${txToUndo.accountId} balance by ${delta}`);
              }
              await txn.delete(transactions).where(eq(transactions.id, entityId));
              console.log(`[UNDO Create] Directly deleted transaction ${entityId} (no cancellation record)`);
            });
            break;
          }
          case 'transaction_approved': {
            const { previousTransaction, balanceDelta, accountId: approvedAccountId, createdNextInstanceId: nextInstId } = data;

            await db.transaction(async (txn) => {
              await txn.update(transactions)
                .set({
                  status: previousTransaction.status,
                  completedBy: previousTransaction.completedBy || null,
                  completedAt: previousTransaction.completedAt || null,
                })
                .where(eq(transactions.id, entityId));

              if (balanceDelta !== 0 && approvedAccountId) {
                await txn.update(accounts)
                  .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) + ${-balanceDelta})` })
                  .where(eq(accounts.id, approvedAccountId));
              }

              if (nextInstId) {
                await txn.delete(transactions).where(eq(transactions.id, nextInstId));
              }

              const currentTxForStock = await storage.getTransaction(entityId);
              if (currentTxForStock) {
                const items = await storage.getTransactionItems(currentTxForStock.id);
                const lines = deriveStockLines(currentTxForStock, items);
                if (lines.length > 0) {
                  await adjustStockForLines({
                    lines,
                    txType: previousTransaction.type,
                    direction: 'reverse',
                    organizationId: entry.organizationId,
                    userId: entry.userId,
                    reason: `[DESHACER APROBACIÓN] ${currentTxForStock.description || ''}`,
                    tx: txn,
                  });
                }
              }
            });
            break;
          }
          case 'transfer_created':
            if (data.outgoing) await storage.deleteTransaction(data.outgoing.id);
            if (data.incoming) await storage.deleteTransaction(data.incoming.id);
            break;
          default:
            return res.status(400).json({ message: `Tipo de entidad no soportado: ${entityType}` });
        }
      } catch (insertError: any) {
        if (insertError.code === '23505') {
          return res.status(409).json({ message: 'El registro ya fue restaurado o recreado.' });
        }
        throw insertError;
      }

      const isUndoCreate = entityType === 'transaction_created' || entityType === 'transfer_created';
      const isUndoApproval = entityType === 'transaction_approved';
      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: (isUndoCreate || isUndoApproval) ? 'transaction' : entityType,
        entityId,
        action: isUndoApproval ? 'undo_approval' : (isUndoCreate ? 'undo_create' : 'restore'),
        previousData: (isUndoCreate || isUndoApproval) ? JSON.stringify(data) : null,
        newData: (isUndoCreate || isUndoApproval) ? null : JSON.stringify(data),
      });

      res.json({ success: true, entityType, entityId });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/accounts/:id/adjust-balance', requireAuth, requirePermission('accounts:edit', 'transactions:create'), adjustBalanceHandler);

  app.post('/api/accounts/:id/force-balance', requireAuth, requirePermission('accounts:edit'), forceBalanceHandler);
  
  // Transaction routes
  app.get('/api/transactions', requireAuth, async (req: any, res) => {
    try {
      const status = req.query.status as 'completed' | 'scheduled' | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 500;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

      // Task #250: filtro opcional por categoría. Acepta CSV o ?category=...
      // repetido. Las comparaciones son exactas contra `transactions.category`
      // (text notNull). El parsing tolera espacios extra y descarta vacíos.
      const rawCategory = req.query.category;
      let categories: string[] | undefined;
      if (typeof rawCategory === 'string' && rawCategory.length > 0) {
        categories = rawCategory.split(',').map((s) => s.trim()).filter(Boolean);
      } else if (Array.isArray(rawCategory)) {
        categories = rawCategory
          .flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
          .map((s) => s.trim())
          .filter(Boolean);
      }

      await storage.promoteScheduledTransactions(req.organizationId);
      
      const safeLimit = Math.min(Math.max(limit, 1), 1000);
      // The transactions list view shows cancelled movements alongside completed
      // ones (with a "Cancelado" badge). We opt in explicitly here so the
      // storage's stricter default (`status='completed'` excludes cancelled)
      // doesn't hide them from the list.
      const transactions = await storage.getTransactionsByOrganization(req.organizationId, status, {
        limit: safeLimit,
        offset,
        includeCancelled: status === 'completed',
        ...(categories ? { categories } : {}),
      });
      
      const creatorIds = Array.from(new Set(transactions.map(tx => tx.createdBy).filter(Boolean))) as string[];
      const creatorsMap = new Map<string, string>();
      
      for (const userId of creatorIds) {
        const user = await storage.getUser(userId);
        if (user) creatorsMap.set(userId, user.name);
      }
      
      // Task #475: attach lightweight line items so reports/profitability can
      // account for multi-product transactions (legacy product fields are null
      // when 2+ products are present). One batch query; single-product txs are
      // unaffected (no `items` key attached).
      const lineItems = await storage.getTransactionItemsByTransactionIds(
        transactions.map((tx) => tx.id),
      );
      const itemsByTx = new Map<string, Array<{ productId: string | null; quantity: string; unitPrice: string; profitabilityCodeId: string | null }>>();
      for (const li of lineItems) {
        const arr = itemsByTx.get(li.transactionId) || [];
        arr.push({
          productId: li.productId,
          quantity: li.quantity,
          unitPrice: li.unitPrice,
          profitabilityCodeId: li.profitabilityCodeId,
        });
        itemsByTx.set(li.transactionId, arr);
      }

      const transactionsWithCreator = transactions.map(tx => ({
        ...tx,
        creatorName: tx.createdBy ? creatorsMap.get(tx.createdBy) || 'Usuario' : null,
        ...(itemsByTx.has(tx.id) ? { items: itemsByTx.get(tx.id) } : {}),
      }));
      
      res.json(transactionsWithCreator);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  // Get linkable transactions (income/receivable that can be linked to expenses)
  // NOTE: Routes with static paths must be BEFORE /api/transactions/:id to avoid route collision
  app.get('/api/transactions/linkable', requireAuth, async (req: any, res) => {
    try {
      const transactions = await storage.getTransactionsByOrganization(req.organizationId);
      
      // Filter to only income/receivable with completed status
      const linkableTypes = ['income', 'receivable'];
      const linkable = transactions.filter(tx => 
        linkableTypes.includes(tx.type) && tx.status === 'completed'
      );
      
      // Calculate available balance for each (original amount - sum of linked COMPLETED expenses only)
      const linkedAmounts = new Map<string, number>();
      transactions.forEach(tx => {
        if (tx.linkedTransactionId && tx.status === 'completed') {
          const current = linkedAmounts.get(tx.linkedTransactionId) || 0;
          linkedAmounts.set(tx.linkedTransactionId, current + parseFloat(tx.amount));
        }
      });
      
      const result = linkable.map(tx => ({
        id: tx.id,
        transactionNumber: tx.transactionNumber,
        description: tx.description,
        amount: tx.amount,
        date: tx.date,
        type: tx.type,
        category: tx.category,
        linkedAmount: linkedAmounts.get(tx.id) || 0,
        availableBalance: parseFloat(tx.amount) - (linkedAmounts.get(tx.id) || 0),
      }));
      
      // Sort by date descending
      result.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Calendar endpoint - get transactions grouped by date range
  // NOTE: Must be BEFORE /api/transactions/:id to avoid route collision
  // The handler body lives below as the exported `calendarHandler` so the
  // integration tests in `tests/calendarTransfersEndpoint.test.ts` can mount
  // the SAME function used in production without paying the cost of the
  // session/subscription middleware (covered separately).
  app.get('/api/transactions/calendar', requireAuth, calendarHandler);

  // ─────────────────────────────────────────────────────────────────────────
  // Task #202 — Aggregation endpoint para "Reportes por miembro del equipo".
  //
  // GET /api/transactions/by-member?from=YYYY-MM-DD&to=YYYY-MM-DD&codeId=...
  //
  // Devuelve, para cada miembro de la organización (más un grupo
  // `unassigned` para movimientos sin createdBy), el total de ingresos,
  // total de gastos y conteo en el período pedido — en moneda original
  // de cada transacción, con metadata de miembro (id, name, email, role).
  //
  // Las exclusiones son las MISMAS que aplica el frontend vía
  // buildReportableTxFilter: cancelados, espejos [CANCELACIÓN],
  // transfer_in/transfer_out (no son ingresos ni gastos reales). El filtro
  // opcional `codeId` se aplica como AND si es distinto de "all" / vacío.
  //
  // El bloque visual sigue calculando agregados client-side (es coherente
  // con cómo Reportes computa todas las demás cards desde useTransactions),
  // pero este endpoint queda disponible para integraciones, exports y
  // dashboards externos que necesiten el corte por miembro server-side.
  // MUST stay declared BEFORE the catch-all /api/transactions/:id.
  app.get('/api/transactions/by-member', requireAuth, async (req: any, res) => {
    try {
      const { from, to, codeId } = req.query as { from?: string; to?: string; codeId?: string };
      const fromDate = from ? new Date(from) : null;
      const toDate = to ? new Date(to) : null;
      if (fromDate && Number.isNaN(fromDate.getTime())) {
        return res.status(400).json({ message: 'Parámetro "from" inválido (formato YYYY-MM-DD esperado)' });
      }
      if (toDate && Number.isNaN(toDate.getTime())) {
        return res.status(400).json({ message: 'Parámetro "to" inválido (formato YYYY-MM-DD esperado)' });
      }

      const [allTx, members] = await Promise.all([
        storage.getTransactionsByOrganization(req.organizationId),
        storage.getMembersByOrganization(req.organizationId),
      ]);

      const codeFilterActive = !!codeId && codeId !== 'all';

      // #477: en ventas/compras multi-producto el código de rentabilidad vive
      // por renglón en transaction_items (el campo legacy de la transacción
      // queda en null). Para que el filtro por código no subcuente esos casos,
      // cargamos los códigos de los renglones y matcheamos contra ellos también.
      // Solo se consulta cuando hay filtro activo (no penaliza el caso general).
      const itemCodesByTx = new Map<string, Set<string>>();
      if (codeFilterActive) {
        const items = await storage.getTransactionItemsByTransactionIds(allTx.map((t) => t.id));
        for (const it of items) {
          if (!it.profitabilityCodeId) continue;
          const set = itemCodesByTx.get(it.transactionId) || new Set<string>();
          set.add(it.profitabilityCodeId);
          itemCodesByTx.set(it.transactionId, set);
        }
      }

      const isReportable = (t: typeof allTx[number]) => {
        if (t.status === 'cancelled') return false;
        if (isCancellationEntry(t)) return false;
        if (t.type === 'transfer_in' || t.type === 'transfer_out') return false;
        if (codeFilterActive) {
          const matchesLegacy = t.profitabilityCodeId === codeId;
          const matchesItem = itemCodesByTx.get(t.id)?.has(codeId!) ?? false;
          if (!matchesLegacy && !matchesItem) return false;
        }
        const ref = (t as any).imputationDate || t.date;
        if (!ref) return false;
        const d = new Date(ref as any);
        if (Number.isNaN(d.getTime())) return false;
        if (fromDate && d < fromDate) return false;
        if (toDate && d > toDate) return false;
        return true;
      };

      type Bucket = {
        userId: string | null;
        name: string | null;
        email: string | null;
        role: string | null;
        totalIngresos: number;
        totalEgresos: number;
        countIngresos: number;
        countEgresos: number;
      };
      const empty = (m?: { user: any; membership: any }): Bucket => ({
        userId: m?.user?.id ?? null,
        name: m?.user?.name ?? null,
        email: m?.user?.email ?? null,
        role: m?.membership?.role ?? null,
        totalIngresos: 0,
        totalEgresos: 0,
        countIngresos: 0,
        countEgresos: 0,
      });
      const buckets = new Map<string, Bucket>();
      members.forEach((m) => buckets.set(m.user.id, empty(m)));
      const UNASSIGNED = '__unassigned__';

      for (const t of allTx) {
        if (!isReportable(t)) continue;
        const key = t.createdBy ?? UNASSIGNED;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = empty();
          buckets.set(key, bucket);
        }
        const amount = parseFloat(String(t.amount ?? '0')) || 0;
        if (t.type === 'income' || t.type === 'receivable') {
          bucket.totalIngresos += amount;
          bucket.countIngresos += 1;
        } else if (t.type === 'expense' || t.type === 'payable') {
          bucket.totalEgresos += amount;
          bucket.countEgresos += 1;
        }
      }

      const memberRows: Bucket[] = [];
      members.forEach((m) => {
        const b = buckets.get(m.user.id);
        if (b) memberRows.push(b);
      });
      const orphan = buckets.get(UNASSIGNED);
      const includeOrphan = !!orphan && (orphan.countIngresos > 0 || orphan.countEgresos > 0);

      res.json({
        from: from || null,
        to: to || null,
        codeId: codeFilterActive ? codeId : 'all',
        members: memberRows,
        unassigned: includeOrphan ? orphan : null,
      });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Orphan internal-transfer endpoints (Tasks #173 + #177)
  //
  // An internal transfer is a money movement between two accounts of the same
  // organization. It MUST exist as two paired rows linked by `transferPairId`:
  // a `transfer_out` (debits the source account) and a `transfer_in` (credits
  // the destination account). When only one leg exists — either because the
  // counterpart was deleted manually or the row was created by a legacy code
  // path that didn't set `transferPairId` — the money silently "disappears"
  // from totals because internal transfers are excluded from cashflow. The
  // calendar endpoint already detects and surfaces these (see `summary.orphan
  // Transfers*` in `calendarHandler`); this endpoint gives the user a way to
  // (1) list every orphan from one place and (2) repair each one with the
  // intended counterpart, convert it to a regular income/expense, or cancel
  // it.
  //
  // MUST stay declared BEFORE the catch-all `/api/transactions/:id` so its
  // path doesn't get matched as `id="orphan-transfers"`.
  app.get('/api/transactions/orphan-transfers', requireAuth, async (req: any, res) => {
    try {
      const allTx = await storage.getTransactionsByOrganization(req.organizationId);
      // CRITICAL: also exclude `[CANCELACIÓN]` mirror rows. `storage.deleteTransaction`
      // creates them with type='transfer_in/transfer_out' and no `transferPairId`,
      // so without this filter every cancelled orphan would IMMEDIATELY reappear
      // here as a brand-new orphan candidate (and the user could "repair" the
      // very mirror that exists only to balance the books).
      const liveTransfers = allTx.filter(
        t => (t.type === 'transfer_in' || t.type === 'transfer_out')
          && t.status !== 'cancelled'
          && !isCancellationEntry(t),
      );

      // Group by transferPairId. Rows missing transferPairId are always orphans.
      const noPairIdOrphans: typeof liveTransfers = [];
      const byPair = new Map<string, typeof liveTransfers>();
      for (const t of liveTransfers) {
        if (!t.transferPairId) { noPairIdOrphans.push(t); continue; }
        const list = byPair.get(t.transferPairId) ?? [];
        list.push(t);
        byPair.set(t.transferPairId, list);
      }

      // A pair is orphan iff it does NOT contain BOTH a transfer_in AND a
      // transfer_out. Same logic as the calendar handler.
      const singleLegOrphans: typeof liveTransfers = [];
      for (const [, pair] of byPair) {
        const types = new Set(pair.map(p => p.type));
        if (!types.has('transfer_in') || !types.has('transfer_out')) {
          singleLegOrphans.push(...pair);
        }
      }

      const orphans = [...noPairIdOrphans, ...singleLegOrphans];

      // Enrich with account name + currency so the UI doesn't need a second
      // round-trip. Keep only fields the page actually renders.
      const orgAccounts = await storage.getAccountsByOrganization(req.organizationId);
      const accById = new Map(orgAccounts.map(a => [a.id, a]));
      const enriched = orphans.map(o => {
        const acc = o.accountId ? accById.get(o.accountId) : null;
        return {
          id: o.id,
          transactionNumber: o.transactionNumber,
          type: o.type,
          amount: o.amount,
          currency: o.currency,
          description: o.description,
          category: o.category,
          imputationDate: o.imputationDate,
          date: o.date,
          accountId: o.accountId,
          accountName: acc?.name ?? null,
          accountCurrency: acc?.currency ?? null,
          transferPairId: o.transferPairId ?? null,
          reason: o.transferPairId ? 'missing_counterpart_leg' : 'no_pair_id',
        };
      });

      res.json({ orphans: enriched });
    } catch (error: any) {
      console.error('[OrphanTransfers] list error:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  const repairBodySchema = z.object({
    action: z.enum(['create_pair', 'convert_to_regular', 'cancel']),
    counterpartAccountId: z.string().optional(),
    regularType: z.enum(['income', 'expense']).optional(),
    regularCategory: z.string().optional(),
  });

  // Performs a single orphan-transfer repair. Returned shape carries an
  // explicit `ok`/`status`/`message` pair so both the single-id endpoint and
  // the batch endpoint (Task #179) can surface partial-failure information
  // consistently without duplicating the validation/transaction/audit logic.
  type RepairOk =
    | { ok: true; status: 200; action: 'create_pair'; orphanId: string; counterpart: any; transferPairId: string }
    | { ok: true; status: 200; action: 'convert_to_regular'; orphanId: string; transaction: any }
    | { ok: true; status: 200; action: 'cancel'; orphanId: string; cancellationId: string };
  type RepairErr = { ok: false; status: number; orphanId: string; message: string };
  type RepairResult = RepairOk | RepairErr;

  async function performOrphanRepair(args: {
    orphanId: string;
    action: 'create_pair' | 'convert_to_regular' | 'cancel';
    counterpartAccountId?: string;
    regularType?: 'income' | 'expense';
    regularCategory?: string;
    organizationId: string;
    userId: string;
  }): Promise<RepairResult> {
    const { orphanId, action, counterpartAccountId, regularType, regularCategory, organizationId, userId } = args;

    const orphan = await storage.getTransaction(orphanId);
    if (!orphan) return { ok: false, status: 404, orphanId, message: 'Transacción no encontrada' };
    if (orphan.organizationId !== organizationId) {
      return { ok: false, status: 403, orphanId, message: 'No tenés acceso a esta transacción' };
    }
    if (orphan.type !== 'transfer_in' && orphan.type !== 'transfer_out') {
      return { ok: false, status: 400, orphanId, message: 'Solo se pueden reparar transferencias internas' };
    }
    if (orphan.status === 'cancelled') {
      return { ok: false, status: 400, orphanId, message: 'La transferencia ya está cancelada' };
    }

    // Re-confirm the row really is orphan at the time of repair, so two
    // concurrent users can't both fix the "same" orphan and create a third
    // dangling leg. We treat a row as orphan if it has no pair_id OR if the
    // counterpart leg cannot be found in the org.
    let isStillOrphan = true;
    if (orphan.transferPairId) {
      const allOrgTx = await storage.getTransactionsByOrganization(organizationId);
      const counterpart = allOrgTx.find(t =>
        t.transferPairId === orphan.transferPairId &&
        t.id !== orphan.id &&
        t.status !== 'cancelled' &&
        (t.type === 'transfer_in' || t.type === 'transfer_out') &&
        t.type !== orphan.type,
      );
      if (counterpart) isStillOrphan = false;
    }
    if (!isStillOrphan) {
      return { ok: false, status: 409, orphanId, message: 'La transferencia ya tiene contraparte; refrescá la lista' };
    }

    if (action === 'create_pair') {
      if (!counterpartAccountId) {
        return { ok: false, status: 400, orphanId, message: 'Falta la cuenta de contraparte' };
      }
      if (counterpartAccountId === orphan.accountId) {
        return { ok: false, status: 400, orphanId, message: 'La cuenta de contraparte debe ser distinta a la del orfanato' };
      }
      const counterpartAccount = await storage.getAccount(counterpartAccountId);
      if (!counterpartAccount || counterpartAccount.organizationId !== organizationId) {
        return { ok: false, status: 404, orphanId, message: 'Cuenta de contraparte no encontrada' };
      }
      const orphanAccount = orphan.accountId ? await storage.getAccount(orphan.accountId) : null;
      if (orphanAccount && orphanAccount.currency !== counterpartAccount.currency) {
        return {
          ok: false, status: 400, orphanId,
          message: 'La reparación automática solo soporta cuentas de la misma moneda. Para cambio de moneda, cancelá esta transferencia y creá una nueva con tipo de cambio.',
        };
      }

      const pairId = orphan.transferPairId ?? crypto.randomUUID();
      const counterpartType: 'transfer_in' | 'transfer_out' =
        orphan.type === 'transfer_out' ? 'transfer_in' : 'transfer_out';
      const amount = parseFloat(orphan.amount);
      const now = new Date();

      const org = await storage.getOrganization(organizationId);
      const orgSuffix = (org?.name || 'XXXX').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4).padEnd(4, 'X');
      const counter = await storage.incrementTransactionCounter(organizationId);
      const transactionNumber = `MOV-${String(counter).padStart(4, '0')}-${orgSuffix}`;

      const counterpartDescription = counterpartType === 'transfer_in'
        ? `Transferencia desde ${orphanAccount?.name ?? 'cuenta'} (reparada)`
        : `Transferencia a ${orphanAccount?.name ?? 'cuenta'} (reparada)`;

      const result = await db.transaction(async (tx) => {
        if (!orphan.transferPairId) {
          await tx.update(transactions)
            .set({ transferPairId: pairId })
            .where(eq(transactions.id, orphan.id));
        }
        const [created] = await tx.insert(transactions).values({
          type: counterpartType,
          amount: String(amount),
          currency: orphan.currency,
          description: counterpartDescription,
          category: orphan.category || 'Transferencia Interna',
          imputationDate: orphan.imputationDate ?? now,
          date: orphan.date ?? now,
          accountId: counterpartAccountId,
          organizationId,
          hasInvoice: false,
          status: 'completed',
          completedBy: userId,
          completedAt: now,
          assetType: 'transfer',
          transferPairId: pairId,
          createdBy: userId,
          transactionNumber,
        }).returning();

        const delta = counterpartType === 'transfer_in' ? amount : -amount;
        await tx.update(accounts)
          .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) + ${delta})` })
          .where(eq(accounts.id, counterpartAccountId));

        return created;
      });

      await storage.createAuditLog({
        organizationId,
        userId,
        entityType: 'transaction',
        entityId: orphan.id,
        action: 'orphan_transfer_repaired',
        previousData: JSON.stringify(orphan),
        newData: JSON.stringify({ action: 'create_pair', counterpartId: result.id, transferPairId: pairId }),
      });

      return { ok: true, status: 200, action: 'create_pair', orphanId: orphan.id, counterpart: result, transferPairId: pairId };
    }

    if (action === 'convert_to_regular') {
      const newType: 'income' | 'expense' = regularType
        ?? (orphan.type === 'transfer_in' ? 'income' : 'expense');

      const amount = parseFloat(orphan.amount);
      const orphanIsCredit = orphan.type === 'transfer_in';
      const newIsCredit = newType === 'income';
      const delta = orphanIsCredit === newIsCredit ? 0 : (newIsCredit ? 2 * amount : -2 * amount);

      const updated = await db.transaction(async (tx) => {
        const [row] = await tx.update(transactions).set({
          type: newType,
          transferPairId: null,
          assetType: null,
          category: regularCategory || (newType === 'income' ? 'Otros ingresos' : 'Otros gastos'),
          description: orphan.description?.startsWith('[REPARADA]')
            ? orphan.description
            : `[REPARADA] ${orphan.description ?? ''}`.trim(),
        }).where(eq(transactions.id, orphan.id)).returning();

        if (delta !== 0 && orphan.accountId) {
          await tx.update(accounts)
            .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) + ${delta})` })
            .where(eq(accounts.id, orphan.accountId));
        }
        return row;
      });

      await storage.createAuditLog({
        organizationId,
        userId,
        entityType: 'transaction',
        entityId: orphan.id,
        action: 'orphan_transfer_repaired',
        previousData: JSON.stringify(orphan),
        newData: JSON.stringify({ action: 'convert_to_regular', newType, balanceDelta: delta }),
      });

      return { ok: true, status: 200, action: 'convert_to_regular', orphanId: orphan.id, transaction: updated };
    }

    // action === 'cancel'
    const deleteResult = await storage.deleteTransaction(orphan.id);
    if (!deleteResult.deleted) {
      return { ok: false, status: 500, orphanId, message: 'No se pudo cancelar la transferencia' };
    }
    await storage.createAuditLog({
      organizationId,
      userId,
      entityType: 'transaction',
      entityId: orphan.id,
      action: 'orphan_transfer_repaired',
      previousData: JSON.stringify(orphan),
      newData: JSON.stringify({ action: 'cancel', cancellationId: deleteResult.cancellationId }),
    });
    return { ok: true, status: 200, action: 'cancel', orphanId: orphan.id, cancellationId: deleteResult.cancellationId! };
  }

  app.post('/api/transactions/orphan-transfers/:id/repair', requireAuth, requirePermission('transactions:edit'), async (req: any, res) => {
    try {
      const { id } = req.params;
      const parsed = repairBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Cuerpo inválido', issues: parsed.error.issues });
      }
      const { action, counterpartAccountId, regularType, regularCategory } = parsed.data;
      const result = await performOrphanRepair({
        orphanId: id,
        action,
        counterpartAccountId,
        regularType,
        regularCategory,
        organizationId: req.organizationId,
        userId: req.userId,
      });
      if (!result.ok) {
        return res.status(result.status).json({ message: result.message });
      }
      // Preserve the legacy single-endpoint response shape for back-compat.
      if (result.action === 'create_pair') {
        return res.json({ success: true, action: 'create_pair', orphanId: result.orphanId, counterpart: result.counterpart, transferPairId: result.transferPairId });
      }
      if (result.action === 'convert_to_regular') {
        return res.json({ success: true, action: 'convert_to_regular', transaction: result.transaction });
      }
      return res.json({ success: true, action: 'cancel', cancellationId: result.cancellationId });
    } catch (error: any) {
      console.error('[OrphanTransfers] repair error:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Batch repair endpoint (Task #179). Accepts a list of items, each with its
  // own action + parameters, and processes them sequentially. Sequential
  // execution keeps audit/balance updates ordered and avoids deadlocks on the
  // same counterpart account when the user fixes 30 orphans pointing to the
  // same destination. Returns a per-id result so the UI can show "X repaired,
  // Y failed" with reasons.
  const repairBatchBodySchema = z.object({
    items: z.array(z.object({
      id: z.string().min(1),
      action: z.enum(['create_pair', 'convert_to_regular', 'cancel']),
      counterpartAccountId: z.string().optional(),
      regularType: z.enum(['income', 'expense']).optional(),
      regularCategory: z.string().optional(),
    })).min(1).max(200),
  });

  app.post('/api/transactions/orphan-transfers/repair-batch', requireAuth, requirePermission('transactions:edit'), async (req: any, res) => {
    try {
      const parsed = repairBatchBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Cuerpo inválido', issues: parsed.error.issues });
      }
      const { items } = parsed.data;

      const results: Array<{
        id: string;
        ok: boolean;
        action?: string;
        message?: string;
        status?: number;
        counterpartId?: string;
        transferPairId?: string;
        cancellationId?: string;
      }> = [];

      for (const item of items) {
        try {
          const r = await performOrphanRepair({
            orphanId: item.id,
            action: item.action,
            counterpartAccountId: item.counterpartAccountId,
            regularType: item.regularType,
            regularCategory: item.regularCategory,
            organizationId: req.organizationId,
            userId: req.userId,
          });
          if (!r.ok) {
            results.push({ id: item.id, ok: false, status: r.status, message: r.message, action: item.action });
            continue;
          }
          if (r.action === 'create_pair') {
            results.push({ id: item.id, ok: true, action: 'create_pair', counterpartId: r.counterpart.id, transferPairId: r.transferPairId });
          } else if (r.action === 'convert_to_regular') {
            results.push({ id: item.id, ok: true, action: 'convert_to_regular' });
          } else {
            results.push({ id: item.id, ok: true, action: 'cancel', cancellationId: r.cancellationId });
          }
        } catch (err: any) {
          // One bad row must NOT take down the whole batch — we still want
          // the user to see which others were repaired.
          console.error('[OrphanTransfers] batch item error:', item.id, err);
          results.push({ id: item.id, ok: false, status: 500, message: sanitizeError(err), action: item.action });
        }
      }

      const succeeded = results.filter(r => r.ok).length;
      const failed = results.length - succeeded;
      return res.json({ success: failed === 0, succeeded, failed, results });
    } catch (error: any) {
      console.error('[OrphanTransfers] batch error:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/transactions/:id', requireAuth, async (req: any, res) => {
    try {
      const { id } = req.params;
      const transaction = await storage.getTransaction(id);
      
      if (!transaction) {
        return res.status(404).json({ message: 'Transacción no encontrada' });
      }
      
      if (transaction.organizationId !== req.organizationId) {
        return res.status(403).json({ message: 'No tienes acceso a esta transacción' });
      }
      
      const [account, creator, client, supplier, product, parentTransaction, completedByUser, paymentMethod] = await Promise.all([
        transaction.accountId ? storage.getAccount(transaction.accountId) : null,
        transaction.createdBy ? storage.getUser(transaction.createdBy) : null,
        transaction.clientId ? storage.getClient(transaction.clientId) : null,
        transaction.supplierId ? storage.getSupplier(transaction.supplierId) : null,
        transaction.productId ? storage.getProduct(transaction.productId) : null,
        transaction.linkedTransactionId ? storage.getTransaction(transaction.linkedTransactionId) : null,
        transaction.completedBy ? storage.getUser(transaction.completedBy) : null,
        transaction.paymentMethodId ? storage.getPaymentMethodWithConcepts(transaction.paymentMethodId) : null,
      ]);
      
      const allOrgTransactions = await storage.getTransactionsByOrganization(req.organizationId);
      const childTransactions = allOrgTransactions.filter(t => t.linkedTransactionId === transaction.id);

      // Task #475: surface multi-product line items (enriched with product name/sku).
      const lineItems = await storage.getTransactionItems(transaction.id);
      const lineItemProducts = await Promise.all(
        lineItems.map((li) => (li.productId ? storage.getProduct(li.productId) : Promise.resolve(null))),
      );
      const items = lineItems.map((li, idx) => ({
        ...li,
        product: lineItemProducts[idx]
          ? { id: lineItemProducts[idx]!.id, name: lineItemProducts[idx]!.name, sku: lineItemProducts[idx]!.sku, salePrice: lineItemProducts[idx]!.salePrice, ivaAliquot: (lineItemProducts[idx] as any)!.ivaAliquot }
          : null,
      }));

      // Transfer pair / orphan info: when this transaction is one leg of an
      // internal transfer (`transfer_in`/`transfer_out`), find its counterpart
      // (the other leg with the same `transferPairId`, ignoring cancelled
      // rows). If the counterpart is missing — either because the row was
      // created without `transferPairId` or because the other leg was deleted
      // — the transfer is "orphan" and the user should be able to repair it
      // (recreate the missing leg) or convert it into a normal income/expense
      // so it stops silently disappearing from the cashflow.
      let transferPair: { id: string; transactionNumber: string | null; type: string; accountId: string | null; amount: string; status: string } | null = null;
      let isOrphanTransfer = false;
      let orphanReason: 'no_pair_id' | 'missing_counterpart' | null = null;
      if (transaction.type === 'transfer_in' || transaction.type === 'transfer_out') {
        if (!transaction.transferPairId) {
          isOrphanTransfer = true;
          orphanReason = 'no_pair_id';
        } else {
          const counterpart = allOrgTransactions.find(t =>
            t.id !== transaction.id &&
            t.transferPairId === transaction.transferPairId &&
            (t.type === 'transfer_in' || t.type === 'transfer_out') &&
            t.status !== 'cancelled',
          );
          if (counterpart) {
            transferPair = {
              id: counterpart.id,
              transactionNumber: counterpart.transactionNumber,
              type: counterpart.type,
              accountId: counterpart.accountId,
              amount: counterpart.amount,
              status: counterpart.status,
            };
          } else {
            isOrphanTransfer = true;
            orphanReason = 'missing_counterpart';
          }
        }
      }

      res.json({
        ...transaction,
        completedByName: completedByUser?.name || null,
        account: account ? { id: account.id, name: account.name, type: account.type, currency: account.currency } : null,
        creator: creator ? { id: creator.id, name: creator.name, email: creator.email } : null,
        client: client ? { id: client.id, name: client.name, email: client.email, phone: client.phone, taxId: client.taxId } : null,
        supplier: supplier ? { id: supplier.id, name: supplier.name, email: supplier.email, phone: supplier.phone, taxId: supplier.taxId } : null,
        product: product ? { id: product.id, name: product.name, sku: product.sku, salePrice: product.salePrice, ivaAliquot: (product as any).ivaAliquot } : null,
        items,
        parentTransaction: parentTransaction ? { 
          id: parentTransaction.id, 
          transactionNumber: parentTransaction.transactionNumber,
          description: parentTransaction.description,
          amount: parentTransaction.amount,
          type: parentTransaction.type 
        } : null,
        childTransactions: childTransactions.map(ct => ({
          id: ct.id,
          transactionNumber: ct.transactionNumber,
          description: ct.description,
          amount: ct.amount,
          type: ct.type,
          status: ct.status,
        })),
        // Task #229: surface payment-method info for traceability in the UI.
        paymentMethod: paymentMethod ? {
          id: paymentMethod.id,
          name: paymentMethod.name,
          isActive: paymentMethod.isActive,
          concepts: paymentMethod.concepts.map(c => ({
            id: c.id, name: c.name, kind: c.kind, value: c.value,
          })),
        } : null,
        transferPair,
        isOrphanTransfer,
        orphanReason,
      });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  app.post('/api/transactions', requireAuth, requirePermission('transactions:create'), async (req: any, res) => {
    try {
      const { allowOverdraft, ...bodyData } = normalizeAssetTypeKey(req.body);
      const parsed = parseTransactionInsertBody(bodyData);
      if (respondIfInvalid(res, parsed)) return;
      const data = { ...parsed.data };

      // Task #475: optional multi-product line items. Only honored for
      // ventas/compras (income/receivable/expense/payable) with 2+ products;
      // anything else falls back to the legacy single-product fields.
      let inputItems: z.infer<typeof transactionItemsInputSchema> = [];
      if (Array.isArray((req.body as any)?.items)) {
        const itemsParsed = transactionItemsInputSchema.safeParse((req.body as any).items);
        if (!itemsParsed.success) {
          return res.status(400).json({ message: 'Renglones de productos inválidos' });
        }
        inputItems = itemsParsed.data;
      }
      const productBearingType = ['income', 'receivable', 'expense', 'payable'].includes(data.type);
      const isMultiProduct = productBearingType && inputItems.length >= 2;
      if (inputItems.length >= 2 && !productBearingType) {
        return res.status(400).json({ message: 'Los renglones de productos solo aplican a ventas y compras' });
      }
      // When multi-product, the legacy single-product fields must be empty:
      // transaction_items is the source of truth.
      if (isMultiProduct) {
        data.productId = null;
        data.productQuantity = null;
      }

      // Validate every line's product (and optional profitability code) belongs
      // to the caller's organization. Resolve description/default code from the
      // product so the stored rows are self-contained snapshots.
      const resolvedItems: Array<{ productId: string; quantity: string; unitPrice: string; description: string | null; profitabilityCodeId: string | null }> = [];
      if (isMultiProduct) {
        for (const it of inputItems) {
          const product = await storage.getProduct(it.productId);
          if (!product || product.organizationId !== req.organizationId) {
            return res.status(400).json({ message: 'Producto inválido en uno de los renglones' });
          }
          const qtyNum = parseFloat(String(it.quantity));
          const priceNum = parseFloat(String(it.unitPrice));
          if (isNaN(qtyNum) || qtyNum <= 0) {
            return res.status(400).json({ message: `Cantidad inválida para "${product.name}"` });
          }
          if (isNaN(priceNum) || priceNum < 0) {
            return res.status(400).json({ message: `Precio inválido para "${product.name}"` });
          }
          let codeId = it.profitabilityCodeId ?? null;
          if (codeId) {
            const code = await storage.getProfitabilityCode(codeId);
            if (!code || code.organizationId !== req.organizationId) {
              return res.status(400).json({ message: 'Código de rentabilidad inválido en un renglón' });
            }
          } else if (product.defaultProfitabilityCodeId) {
            codeId = product.defaultProfitabilityCodeId;
          }
          resolvedItems.push({
            productId: it.productId,
            quantity: String(qtyNum),
            unitPrice: String(priceNum),
            description: (it.description ?? product.name) || null,
            profitabilityCodeId: codeId,
          });
        }
      }

      // T004: Validate positive amount
      const parsedAmountVal = parseFloat(data.amount);
      if (isNaN(parsedAmountVal) || parsedAmountVal <= 0) {
        return res.status(400).json({ message: 'El monto debe ser un número mayor a cero' });
      }

      // Invoice number format (ARCA `PPPP-NNNNNNNN`) is enforced inside
      // `insertTransactionSchema` via `refineInvoiceNumberFormat`. Anything
      // that reaches this point with `hasInvoice` set already has a valid
      // canonical value, so no further normalization is needed here.

      if (data.accountId) {
        const targetAccount = await storage.getAccount(data.accountId);
        if (targetAccount) {
          if (!data.currency) {
            data.currency = targetAccount.currency;
          } else {
            const acctCurrency = targetAccount.currency === 'USD_CASH' ? 'USD' : targetAccount.currency;
            const txCurrency = data.currency === 'USD_CASH' ? 'USD' : data.currency;
            if (acctCurrency !== txCurrency) {
              return res.status(400).json({ message: `La moneda de la transacción (${data.currency}) no coincide con la cuenta (${targetAccount.currency})` });
            }
          }
        }
      }
      
      if ((data.type === 'payable' || data.type === 'receivable') && data.date) {
        const txDate = new Date(data.date);
        txDate.setHours(0, 0, 0, 0);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (txDate < today) {
          return res.status(400).json({ message: 'Los compromisos pendientes deben tener fecha de hoy o futura' });
        }
      }

      if (data.projectId) {
        const project = await storage.getProject(data.projectId);
        if (!project || !data.clientId) {
          return res.status(400).json({ message: 'Proyecto inválido' });
        }
        if (project.clientId !== data.clientId) {
          return res.status(400).json({ message: 'El proyecto no pertenece al cliente seleccionado' });
        }
      }

      if (!allowOverdraft && data.accountId && (data.type === 'expense' || data.type === 'payable')) {
        const account = await storage.getAccount(data.accountId);
        if (account && account.type === 'cash') {
          const currentBalance = parseFloat(account.balance.toString());
          const transactionAmount = parseFloat(data.amount.toString());
          if (currentBalance - transactionAmount < 0) {
            return res.status(400).json({ 
              message: `No hay suficiente efectivo en "${account.name}". Saldo actual: $${currentBalance.toLocaleString('es-AR')}` 
            });
          }
        }
      }
      
      // Default profitability code from product if not explicitly set
      // (transfers never carry a code by design)
      if (
        data.productId &&
        !data.profitabilityCodeId &&
        data.type !== 'transfer_in' &&
        data.type !== 'transfer_out'
      ) {
        try {
          const productForDefault = await storage.getProduct(data.productId);
          if (productForDefault?.defaultProfitabilityCodeId) {
            data.profitabilityCodeId = productForDefault.defaultProfitabilityCodeId;
          }
        } catch {
          // Non-fatal: a missing product is caught by other validations.
        }
      }
      // Hard-strip profitabilityCodeId on transfers regardless of caller input
      if (data.type === 'transfer_in' || data.type === 'transfer_out') {
        data.profitabilityCodeId = null;
      }

      // Validate profitability code belongs to the same organization (prevents cross-org leak)
      if (data.profitabilityCodeId) {
        const code = await storage.getProfitabilityCode(data.profitabilityCodeId);
        if (!code || code.organizationId !== req.organizationId) {
          return res.status(400).json({ message: 'Código de rentabilidad inválido' });
        }
      }

      // Task #252: if `category` is non-null/non-empty, validate (case-
      // insensitive) against the organization's `transactionCategories` and
      // canonicalize the casing on match; reject with 400 on miss. Null or
      // empty/whitespace is accepted as "movement without category" and
      // passed through unchanged. Transfers are exempt: their server-
      // generated labels (e.g. 'Transferencia Interna') do not live in the
      // catalog.
      if (data.type !== 'transfer_in' && data.type !== 'transfer_out') {
        const result = await validateTransactionCategory(req.organizationId, data.type, data.category);
        if (!result.ok) {
          return res.status(400).json({ message: result.message, field: 'category' });
        }
        // `canonical: null` means null/empty input — persist as a real null
        // (column is nullable since task #252).
        data.category = result.canonical;
      }

      // Task #229: validate paymentMethodId. Only allowed on income or
      // receivable parents. Strip silently on any other type so callers
      // cannot smuggle the field onto unsupported transaction types.
      let paymentMethodForChildren: Awaited<ReturnType<typeof storage.getPaymentMethodWithConcepts>> | undefined;
      if (data.paymentMethodId) {
        if (data.type !== 'income' && data.type !== 'receivable') {
          data.paymentMethodId = null;
        } else {
          const method = await storage.getPaymentMethodWithConcepts(data.paymentMethodId);
          if (!method || method.organizationId !== req.organizationId) {
            return res.status(400).json({ message: 'Medio de cobro inválido' });
          }
          if (!method.isActive) {
            return res.status(400).json({ message: 'El medio de cobro está inactivo' });
          }
          if (method.concepts.length === 0) {
            // No concepts means no children to generate. Treat as a no-op so
            // the field becomes informational on the parent only.
            paymentMethodForChildren = undefined;
          } else {
            paymentMethodForChildren = method;
          }
        }
      }

      const org = await storage.getOrganization(req.organizationId);
      const orgSuffix = (org?.name || 'XXXX').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4).padEnd(4, 'X');
      const counter = await storage.incrementTransactionCounter(req.organizationId);
      const seqNumber = String(counter).padStart(4, '0');
      const transactionNumber = `MOV-${seqNumber}-${orgSuffix}`;
      
      // Add completedBy and completedAt for transactions that start as completed
      const isCompleted = data.status === 'completed' || 
        (!data.status && data.type !== 'payable' && data.type !== 'receivable');

      // Task #353: counter inicial server-side. El cliente sólo declara el
      // total de cuotas; el contador actual lo administra el backend para
      // que no se pueda saltar/spoofear la serie.
      const initialInstallment =
        data.isRecurring && (data as any).recurrenceTotalInstallments != null ? 1 : null;

      const parentInsertPayload = {
        ...data,
        recurrenceCurrentInstallment: initialInstallment,
        organizationId: req.organizationId,
        createdBy: req.userId,
        transactionNumber,
        ...(isCompleted && {
          completedBy: req.userId,
          completedAt: new Date(),
        }),
      };

      let transaction: Awaited<ReturnType<typeof storage.createTransaction>>;
      let autoChildren: Awaited<ReturnType<typeof storage.createTransaction>>[] = [];
      if (paymentMethodForChildren) {
        // Pre-allocate one transactionNumber per child so the atomic creator
        // doesn't depend on the counter mid-tx.
        const childNumbers: string[] = [];
        for (let i = 0; i < paymentMethodForChildren.concepts.length; i++) {
          const c = await storage.incrementTransactionCounter(req.organizationId);
          childNumbers.push(`MOV-${String(c).padStart(4, '0')}-${orgSuffix}`);
        }
        const result = await storage.createTransactionWithPaymentMethodChildren(
          parentInsertPayload,
          paymentMethodForChildren,
          { childTransactionNumbers: childNumbers },
        );
        transaction = result.parent;
        autoChildren = result.children;
        // Audit log per child for traceability.
        for (const child of autoChildren) {
          await storage.createAuditLog({
            organizationId: req.organizationId,
            userId: req.userId,
            entityType: 'transaction',
            entityId: child.id,
            action: 'create',
            previousData: null,
            newData: JSON.stringify({ ...child, autoGeneratedFromPaymentMethod: paymentMethodForChildren.id }),
          });
        }
      } else {
        transaction = await storage.createTransaction(parentInsertPayload);
      }
      
      // Task #475: persist multi-product line items on the parent transaction.
      if (isMultiProduct && resolvedItems.length > 0) {
        await storage.createTransactionItems(
          resolvedItems.map((it) => ({
            transactionId: transaction.id,
            organizationId: req.organizationId,
            productId: it.productId,
            description: it.description,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            profitabilityCodeId: it.profitabilityCodeId,
          })),
        );
      }

      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'transaction',
        entityId: transaction.id,
        action: 'create',
        previousData: null,
        newData: JSON.stringify(transaction),
      });

      if (isCompleted) {
        try {
          const lines: StockLine[] = isMultiProduct
            ? resolvedItems.map((it) => ({ productId: it.productId, quantity: parseFloat(it.quantity), profitabilityCodeId: it.profitabilityCodeId }))
            : deriveStockLines(data);
          if (lines.length > 0) {
            const reasonLabel = data.type === 'expense' ? 'Compra' : data.type === 'income' ? 'Venta' : data.type === 'payable' ? 'Compromiso compra' : 'Compromiso venta';
            await adjustStockForLines({
              lines,
              txType: data.type,
              direction: 'apply',
              organizationId: req.organizationId,
              userId: req.userId,
              reason: `${reasonLabel}: ${data.description || ''}`,
            });
          }
        } catch (stockErr) {
          console.error('[Stock] Error updating stock from transaction:', stockErr);
        }
      }
      
      if (isCompleted && (data.type === 'expense' || data.type === 'income')) {
        const entityType = data.type === 'expense' ? 'supplier' : 'client';
        const entityId = data.type === 'expense' ? data.supplierId : data.clientId;
        if (entityId) {
          try {
            const result = await autoApplyPaymentToCommitments({
              paymentAmount: parseFloat(data.amount),
              currency: data.currency || 'ARS',
              organizationId: req.organizationId,
              userId: req.userId,
              entityType: entityType as 'supplier' | 'client',
              entityId,
              paymentTransactionId: transaction.id,
            });
            if (result.appliedCount > 0) {
              console.log(`[AutoApply] Applied payment ${transaction.id} to ${result.appliedCount} commitment(s), total: ${result.appliedTotal}`);
            }
          } catch (autoApplyErr) {
            console.error('[AutoApply] Error auto-applying payment to commitments:', autoApplyErr);
          }
        }
      }

      // Task #356: si la operación recién creada es un Ingreso o Egreso ya
      // completado y está marcado como recurrente, generar inmediatamente la
      // próxima cuota como compromiso pendiente (receivable/payable scheduled).
      // De esta forma las cuotas futuras se ven y se aprueban siempre desde
      // Cobros/Pagos Recurrentes (mismo flujo que payable/receivable). La
      // primera cuota queda como income/expense en Movimientos.
      //
      // IMPORTANTE: corre DESPUÉS de autoApplyPaymentToCommitments para que la
      // cuota futura recién generada no sea consumida instantáneamente por la
      // auto-aplicación (que ordena por fecha asc y no filtra por fecha límite).
      if (
        isCompleted &&
        transaction.isRecurring &&
        transaction.recurrenceFrequency &&
        (transaction.type === 'income' || transaction.type === 'expense')
      ) {
        try {
          const totalInstallments = (transaction as any).recurrenceTotalInstallments as number | null | undefined;
          const currentInstallment = ((transaction as any).recurrenceCurrentInstallment as number | null | undefined) ?? 1;

          if (totalInstallments != null && currentInstallment >= totalInstallments) {
            console.log(`[Recurrence] Income/Expense series complete (${currentInstallment}/${totalInstallments}). Skipping next ${transaction.recurrenceFrequency} commitment.`);
          } else {
            const advanceDate = (d: Date, freq: string): Date => {
              const next = new Date(d);
              switch (freq) {
                case 'weekly': next.setDate(next.getDate() + 7); break;
                case 'biweekly': next.setDate(next.getDate() + 14); break;
                case 'monthly': next.setMonth(next.getMonth() + 1); break;
                case 'quarterly': next.setMonth(next.getMonth() + 3); break;
                case 'yearly': next.setFullYear(next.getFullYear() + 1); break;
                default: next.setMonth(next.getMonth() + 1);
              }
              return next;
            };

            const sourceDate = new Date(transaction.date);
            let nextDueDate = advanceDate(sourceDate, transaction.recurrenceFrequency);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            while (nextDueDate < today) {
              nextDueDate = advanceDate(nextDueDate, transaction.recurrenceFrequency);
            }

            const mirrorType = transaction.type === 'income' ? 'receivable' : 'payable';
            const sourceId = transaction.recurrenceSourceId || transaction.id;

            // Deduplicación: no crear si ya existe una pendiente para la misma fecha.
            const existingDuplicates = await db
              .select({ id: transactions.id })
              .from(transactions)
              .where(and(
                eq(transactions.organizationId, transaction.organizationId),
                eq(transactions.status, 'scheduled'),
                eq(transactions.isRecurring, true),
                eq(transactions.type, mirrorType),
                sql`${transactions.recurrenceSourceId} = ${sourceId}`,
                sql`ABS(EXTRACT(EPOCH FROM (${transactions.date}::timestamp - ${nextDueDate.toISOString()}::timestamp))) < 86400`
              ))
              .limit(1);

            if (existingDuplicates.length === 0) {
              // Task #475: propagate multi-product line items to the generated
              // commitment so its later approval adjusts stock per line. When
              // the source is multi-product (has transaction_items), the child's
              // legacy productId/productQuantity must be null (items are truth).
              const srcItems = await storage.getTransactionItems(transaction.id);
              const isMulti = srcItems.length > 0;
              const nextInstance = await storage.createTransaction({
                type: mirrorType,
                amount: transaction.amount,
                currency: transaction.currency,
                description: transaction.description,
                category: transaction.category,
                date: nextDueDate,
                imputationDate: nextDueDate,
                accountId: transaction.accountId,
                organizationId: transaction.organizationId,
                createdBy: req.userId,
                hasInvoice: false,
                status: 'scheduled',
                clientId: transaction.clientId,
                supplierId: transaction.supplierId,
                productId: isMulti ? null : transaction.productId,
                productQuantity: isMulti ? null : transaction.productQuantity,
                isRecurring: true,
                isUniquePayment: false,
                recurrenceFrequency: transaction.recurrenceFrequency,
                recurrenceSourceId: sourceId,
                recurrenceTotalInstallments: totalInstallments ?? null,
                recurrenceCurrentInstallment:
                  totalInstallments != null ? currentInstallment + 1 : null,
              });
              if (isMulti) {
                await storage.createTransactionItems(srcItems.map((it) => ({
                  transactionId: nextInstance.id,
                  organizationId: transaction.organizationId,
                  productId: it.productId,
                  description: it.description,
                  quantity: it.quantity,
                  unitPrice: it.unitPrice,
                  profitabilityCodeId: it.profitabilityCodeId,
                })));
              }
              console.log(`[Recurrence] Created next ${mirrorType} commitment for ${nextDueDate.toISOString()} from ${transaction.type} ${transaction.id}${totalInstallments != null ? ` (installment ${currentInstallment + 1}/${totalInstallments})` : ''}`);
            }
          }
        } catch (recErr) {
          // No bloquear la respuesta si la generación de la próxima cuota falla;
          // el usuario igualmente verá el movimiento creado y puede recargarla luego.
          console.error('[Recurrence] Failed to generate next instance for income/expense:', recErr);
        }
      }

      const undoKey = stashForUndo('transaction_created', transaction.id, transaction, req.organizationId, req.userId);
      
      res.json({
        ...transaction,
        undoKey,
        // Task #229: when a payment method generated children, surface them
        // so the frontend can show a "Se generaron N costos asociados" toast
        // and pre-warm any related queries.
        ...(autoChildren.length > 0 && { autoGeneratedChildren: autoChildren }),
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        // Defensive: any other ZodError from downstream parsing.
        return res.status(400).json({ message: 'Validation error', errors: error.errors });
      }
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  // Internal transfer between accounts
  app.post('/api/transactions/transfer', requireAuth, requirePermission('transactions:create'), async (req: any, res) => {
    try {
      const { fromAccountId, toAccountId, amount, description, organizationId, isCurrencyExchange, exchangeRate } = req.body;
      
      if (!fromAccountId || !toAccountId || !amount) {
        return res.status(400).json({ message: 'Faltan datos requeridos para la transferencia' });
      }
      
      if (fromAccountId === toAccountId) {
        return res.status(400).json({ message: 'La cuenta de origen y destino no pueden ser la misma' });
      }
      
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({ message: 'El monto debe ser mayor a cero' });
      }
      
      // Get both accounts
      const fromAccount = await storage.getAccount(fromAccountId);
      const toAccount = await storage.getAccount(toAccountId);
      
      if (!fromAccount || !toAccount) {
        return res.status(404).json({ message: 'Una o ambas cuentas no fueron encontradas' });
      }
      
      // Verify accounts belong to the same organization
      if (fromAccount.organizationId !== req.organizationId || toAccount.organizationId !== req.organizationId) {
        return res.status(403).json({ message: 'No tenés permiso para operar estas cuentas' });
      }
      
      // Check if currencies are different and block if not in exchange mode
      const isCrossCurrency = fromAccount.currency !== toAccount.currency;
      if (isCrossCurrency && !isCurrencyExchange) {
        return res.status(400).json({ 
          message: `No se puede transferir entre ${fromAccount.currency} y ${toAccount.currency} sin activar el cambio de moneda` 
        });
      }
      
      // Check if origin account has sufficient balance (for cash accounts)
      if (fromAccount.type === 'cash') {
        const currentBalance = parseFloat(fromAccount.balance.toString());
        if (currentBalance < parsedAmount) {
          return res.status(400).json({ 
            message: `Saldo insuficiente en "${fromAccount.name}". Saldo actual: $${currentBalance.toLocaleString('es-AR')}` 
          });
        }
      }
      
      // Calculate destination amount (apply exchange rate if cross-currency)
      // exchangeRate is always expressed as "1 USD/EUR = X ARS"
      let destinationAmount = parsedAmount;
      let usedExchangeRate = '1';
      if (isCrossCurrency && isCurrencyExchange) {
        // Normalize exchange rate: remove thousand separators (dots) and replace decimal comma
        let normalizedRate = exchangeRate || '1';
        if (typeof normalizedRate === 'string') {
          normalizedRate = normalizedRate.replace(/\./g, '').replace(',', '.');
        }
        const rate = parseFloat(normalizedRate);
        
        // Validate exchange rate for cross-currency transfers
        if (isNaN(rate) || rate <= 1) {
          return res.status(400).json({ 
            message: 'El tipo de cambio debe ser mayor a 1 para transferencias entre monedas diferentes. Por favor, verifica el tipo de cambio.' 
          });
        }
        
        usedExchangeRate = String(rate);
        
        // Determine conversion direction
        const isARStoForeign = fromAccount.currency === 'ARS' && 
          (toAccount.currency === 'USD' || toAccount.currency === 'USD_CASH' || toAccount.currency === 'EUR');
        const isForeignToARS = toAccount.currency === 'ARS' && 
          (fromAccount.currency === 'USD' || fromAccount.currency === 'USD_CASH' || fromAccount.currency === 'EUR');
        
        if (isForeignToARS) {
          // USD/EUR -> ARS: multiply (100 USD * 1470 = 147000 ARS)
          destinationAmount = parsedAmount * rate;
        } else if (isARStoForeign) {
          // ARS -> USD/EUR: divide (147000 ARS / 1470 = 100 USD)
          destinationAmount = parsedAmount / rate;
        } else {
          // Fallback: multiply
          destinationAmount = parsedAmount * rate;
        }
      }
      
      // Generate shared transfer pair ID
      const transferPairId = crypto.randomUUID();
      const now = new Date();
      
      // Get organization for transaction numbering
      const org = await storage.getOrganization(req.organizationId);
      const orgSuffix = (org?.name || 'XXXX').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4).padEnd(4, 'X');
      
      // Build description with exchange rate info if applicable
      const baseDescription = description || (isCrossCurrency 
        ? `Cambio de ${fromAccount.currency} a ${toAccount.currency}`
        : `Transferencia a ${toAccount.name}`);
      const exchangeInfo = isCrossCurrency && isCurrencyExchange 
        ? ` (TC: ${parseFloat(usedExchangeRate).toFixed(2)})`
        : '';
      
      // T003: Create both transfer transactions atomically
      const counterOut = await storage.incrementTransactionCounter(req.organizationId);
      const transactionNumberOut = `MOV-${String(counterOut).padStart(4, '0')}-${orgSuffix}`;
      const counterIn = await storage.incrementTransactionCounter(req.organizationId);
      const transactionNumberIn = `MOV-${String(counterIn).padStart(4, '0')}-${orgSuffix}`;
      
      const inDescription = description || (isCrossCurrency 
        ? `Cambio de ${fromAccount.currency} a ${toAccount.currency}`
        : `Transferencia desde ${fromAccount.name}`);

      const { outgoingTransaction, incomingTransaction } = await db.transaction(async (tx) => {
        const [outgoing] = await tx.insert(transactions).values({
          type: 'transfer_out',
          amount: String(parsedAmount),
          description: baseDescription + exchangeInfo,
          category: isCrossCurrency ? 'Cambio de Moneda' : 'Transferencia Interna',
          imputationDate: now,
          date: now,
          accountId: fromAccountId,
          organizationId: req.organizationId,
          hasInvoice: false,
          status: 'completed',
          completedBy: req.userId,
          completedAt: now,
          assetType: 'transfer',
          transferPairId,
          createdBy: req.userId,
          transactionNumber: transactionNumberOut,
        }).returning();

        const [incoming] = await tx.insert(transactions).values({
          type: 'transfer_in',
          amount: String(destinationAmount),
          description: inDescription + exchangeInfo,
          category: isCrossCurrency ? 'Cambio de Moneda' : 'Transferencia Interna',
          imputationDate: now,
          date: now,
          accountId: toAccountId,
          organizationId: req.organizationId,
          hasInvoice: false,
          status: 'completed',
          completedBy: req.userId,
          completedAt: now,
          assetType: 'transfer',
          transferPairId,
          createdBy: req.userId,
          transactionNumber: transactionNumberIn,
        }).returning();

        await tx.update(accounts)
          .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) - ${parsedAmount})` })
          .where(eq(accounts.id, fromAccountId));
        await tx.update(accounts)
          .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) + ${destinationAmount})` })
          .where(eq(accounts.id, toAccountId));

        return { outgoingTransaction: outgoing, incomingTransaction: incoming };
      });
      
      // Create detailed audit logs with full transfer information
      const transferAuditDetails = {
        transferPairId,
        isCrossCurrency,
        isCurrencyExchange,
        exchangeRate: isCurrencyExchange ? parseFloat(usedExchangeRate) : null,
        fromAccount: {
          id: fromAccount.id,
          name: fromAccount.name,
          currency: fromAccount.currency,
          balanceBefore: parseFloat(fromAccount.balance),
          balanceAfter: parseFloat(fromAccount.balance) - parsedAmount,
        },
        toAccount: {
          id: toAccount.id,
          name: toAccount.name,
          currency: toAccount.currency,
          balanceBefore: parseFloat(toAccount.balance),
          balanceAfter: parseFloat(toAccount.balance) + destinationAmount,
        },
        amounts: {
          origin: parsedAmount,
          originCurrency: fromAccount.currency,
          destination: destinationAmount,
          destinationCurrency: toAccount.currency,
        },
      };
      
      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'transaction',
        entityId: outgoingTransaction.id,
        action: 'create',
        previousData: null,
        newData: JSON.stringify({ 
          ...outgoingTransaction, 
          transferType: 'transfer_out',
          transferDetails: transferAuditDetails,
          pairedTransactionId: incomingTransaction.id,
          pairedTransactionNumber: transactionNumberIn,
        }),
      });
      
      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'transaction',
        entityId: incomingTransaction.id,
        action: 'create',
        previousData: null,
        newData: JSON.stringify({ 
          ...incomingTransaction, 
          transferType: 'transfer_in',
          transferDetails: transferAuditDetails,
          pairedTransactionId: outgoingTransaction.id,
          pairedTransactionNumber: transactionNumberOut,
        }),
      });
      
      const undoKey = stashForUndo('transfer_created', transferPairId, {
        outgoing: outgoingTransaction,
        incoming: incomingTransaction,
      }, req.organizationId, req.userId);
      
      res.json({
        success: true,
        outgoing: outgoingTransaction,
        incoming: incomingTransaction,
        transferPairId,
        undoKey,
      });
    } catch (error: any) {
      console.error('Error creating transfer:', error);
      res.status(500).json({ message: sanitizeError(error) || 'Error al procesar la transferencia' });
    }
  });

  // Repair an orphan internal transfer. An internal transfer should always
  // have BOTH legs (`transfer_in` + `transfer_out` sharing `transferPairId`).
  // When only one leg survives — because the row was created without
  // `transferPairId` (legacy bug) or because the counterpart was deleted —
  // the money silently disappears from the cashflow. This endpoint lets the
  // user fix it from the UI without touching the DB:
  //   action='recreate-pair': recreate the missing leg pointing to a chosen
  //     account (and adjust that account's balance accordingly).
  //   action='convert': convert the orphan leg into a regular income/expense
  //     so it counts again in totals (no balance change is needed because
  //     the original transfer already moved the balance on this account).
  app.post('/api/transactions/:id/repair-transfer', requireAuth, requirePermission('transactions:edit'), repairTransferHandler);

  app.post('/api/transactions/backfill-numbers', requireAuth, async (req: any, res) => {
    try {
      const org = await storage.getOrganization(req.organizationId);
      const orgSuffix = (org?.name || 'XXXX').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4).padEnd(4, 'X');
      
      const allTransactions = await storage.getTransactionsByOrganization(req.organizationId);
      const toBackfill = allTransactions
        .filter(t => !t.transactionNumber)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      
      let updated = 0;
      
      for (const tx of toBackfill) {
        const counter = await storage.incrementTransactionCounter(req.organizationId);
        const seqNumber = String(counter).padStart(4, '0');
        const transactionNumber = `MOV-${seqNumber}-${orgSuffix}`;
        await storage.updateTransaction(tx.id, { transactionNumber });
        updated++;
      }
      
      res.json({ message: `Se asignaron números a ${updated} transacciones`, updated });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.patch('/api/transactions/:id', requireAuth, requirePermission('transactions:edit'), async (req: any, res) => {
    try {
      const { id } = req.params;

      // Task #475: `items` is a route-level extension (not part of the strict
      // updateTransactionSchema). Strip it before parsing the rest of the body
      // so the strict schema doesn't reject the payload; it's validated below.
      const rawItems = (req.body as any)?.items;
      const { items: _ignoredItems, ...bodyWithoutItems } = (req.body as any) ?? {};
      const parseResult = parseTransactionUpdateBody(normalizeAssetTypeKey(bodyWithoutItems));
      if (respondIfInvalid(res, parseResult)) return;
      const updates: Record<string, any> = { ...parseResult.data };

      const currentTx = await storage.getTransaction(id);
      if (!currentTx) {
        return res.status(404).json({ message: 'Transaction not found' });
      }
      
      if (currentTx.organizationId !== req.organizationId) {
        return res.status(403).json({ message: 'No tenés acceso a esta transacción' });
      }

      // Task #489: enforce the canonical ARCA invoice-number format (PPPP-NNNNNNNN)
      // ONLY when `invoiceNumber` actually changes from the stored value. Editing
      // any other field re-sends the existing number, and movements created before
      // the format was enforced (or ARCA-emitted ones that store the bare voucher
      // number) carry non-canonical values — re-validating them blindly would make
      // those movements un-editable (the reported bug). A new, non-empty value that
      // differs from the stored one must still match the canonical format.
      if ('invoiceNumber' in updates) {
        const formatError = invoiceNumberChangeError(updates.invoiceNumber, currentTx.invoiceNumber);
        if (formatError) {
          return res.status(400).json({ message: formatError, field: 'invoiceNumber' });
        }
      }
      
      const txType = updates.type || currentTx.type;
      const txDate = updates.date || currentTx.date;
      const previousStatus = currentTx.status;

      // Hard-strip profitabilityCodeId on transfers regardless of caller input.
      // Force null even when the field isn't in the payload, to preserve the
      // invariant "transfers never carry a code" — including the case where
      // type is being changed to transfer_in/out on an existing tagged row.
      if (txType === 'transfer_in' || txType === 'transfer_out') {
        updates.profitabilityCodeId = null;
      } else if ('profitabilityCodeId' in updates && updates.profitabilityCodeId) {
        // Validate the code belongs to the same org and is active
        const code = await storage.getProfitabilityCode(updates.profitabilityCodeId);
        if (!code || code.organizationId !== req.organizationId) {
          return res.status(400).json({ message: 'Código de rentabilidad inválido' });
        }
        if (!code.isActive) {
          return res.status(400).json({ message: 'El código de rentabilidad está inactivo' });
        }
      }

      // Task #475: optional multi-product line items on edit. Mirrors POST: when
      // 2+ products are sent for a venta/compra (income/receivable/expense/
      // payable) we persist transaction_items and clear the legacy single-
      // product fields; stock is reconciled below. `items` requires 2+ entries
      // (single-product edits use the legacy fields); 0/1 is rejected below.
      if (rawItems !== undefined && !Array.isArray(rawItems)) {
        return res.status(400).json({ message: 'El campo "items" debe ser una lista de renglones' });
      }
      const itemsProvided = Array.isArray(rawItems);
      let editInputItems: z.infer<typeof transactionItemsInputSchema> = [];
      if (itemsProvided) {
        const itemsParsed = transactionItemsInputSchema.safeParse(rawItems);
        if (!itemsParsed.success) {
          return res.status(400).json({ message: 'Renglones de productos inválidos' });
        }
        editInputItems = itemsParsed.data;
      }
      // `items` is only for multi-product (2+). Reject 0/1 explicitly so a stray
      // client can't silently wipe existing line items; single-product edits go
      // through the legacy productId/productQuantity fields instead.
      if (itemsProvided && editInputItems.length < 2) {
        return res.status(400).json({ message: 'Para editar productos enviá al menos 2 renglones; para un solo producto usá los campos individuales' });
      }
      const editProductBearingType = ['income', 'receivable', 'expense', 'payable'].includes(txType);
      const editIsMultiProduct = editProductBearingType && editInputItems.length >= 2;
      if (editInputItems.length >= 2 && !editProductBearingType) {
        return res.status(400).json({ message: 'Los renglones de productos solo aplican a ventas y compras' });
      }
      const editResolvedItems: Array<{ productId: string; quantity: string; unitPrice: string; description: string | null; profitabilityCodeId: string | null }> = [];
      if (editIsMultiProduct) {
        for (const it of editInputItems) {
          const product = await storage.getProduct(it.productId);
          if (!product || product.organizationId !== req.organizationId) {
            return res.status(400).json({ message: 'Producto inválido en uno de los renglones' });
          }
          const qtyNum = parseFloat(String(it.quantity));
          const priceNum = parseFloat(String(it.unitPrice));
          if (isNaN(qtyNum) || qtyNum <= 0) {
            return res.status(400).json({ message: `Cantidad inválida para "${product.name}"` });
          }
          if (isNaN(priceNum) || priceNum < 0) {
            return res.status(400).json({ message: `Precio inválido para "${product.name}"` });
          }
          let codeId = it.profitabilityCodeId ?? null;
          if (codeId) {
            const code = await storage.getProfitabilityCode(codeId);
            if (!code || code.organizationId !== req.organizationId) {
              return res.status(400).json({ message: 'Código de rentabilidad inválido en un renglón' });
            }
          } else if (product.defaultProfitabilityCodeId) {
            codeId = product.defaultProfitabilityCodeId;
          }
          editResolvedItems.push({
            productId: it.productId,
            quantity: String(qtyNum),
            unitPrice: String(priceNum),
            description: (it.description ?? product.name) || null,
            profitabilityCodeId: codeId,
          });
        }
        // When multi-product, the legacy single-product fields must be empty:
        // transaction_items is the source of truth.
        updates.productId = null;
        updates.productQuantity = null;
      }
      // Snapshot existing line items BEFORE mutation so stock can be reversed.
      const oldItemsForEdit = itemsProvided ? await storage.getTransactionItems(id) : [];

      // Task #252: if `category` is in the update payload, validate (case-
      // insensitive) against the organization's `transactionCategories` for
      // the effective `txType` and canonicalize the casing on match; reject
      // with 400 on miss. Null or empty/whitespace is accepted (movement
      // without category) — we drop the key from `updates` to preserve the
      // existing value rather than overwrite. Transfers are exempt.
      if ('category' in updates && txType !== 'transfer_in' && txType !== 'transfer_out') {
        const result = await validateTransactionCategory(req.organizationId, txType, updates.category);
        if (!result.ok) {
          return res.status(400).json({ message: result.message, field: 'category' });
        }
        // `canonical: null` here means the caller explicitly cleared the
        // category (sent null / empty / whitespace). Persist that as a real
        // null on the row — the column is nullable since task #252.
        updates.category = result.canonical;
      }

      if ((txType === 'payable' || txType === 'receivable') && txDate && !updates.status) {
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const transactionDate = new Date(txDate);
        transactionDate.setHours(0, 0, 0, 0);
        
        if (transactionDate > now) {
          updates.status = 'scheduled';
        } else {
          updates.status = 'completed';
        }
      }
      
      const willBeCompleted = updates.status === 'completed' && previousStatus !== 'completed';
      if (willBeCompleted) {
        updates.completedBy = req.userId;
        updates.completedAt = new Date();
        if (currentTx.autoAppliedByTransactionId) {
          updates.autoAppliedByTransactionId = null;
        }
      }
      
      const transaction = await storage.updateTransaction(id, updates);
      if (!transaction) {
        return res.status(404).json({ message: 'Transaction not found' });
      }

      // Task #475: persist edited multi-product line items. `items` is always
      // 2+ here (0/1 rejected above), so replace the rows wholesale (delete +
      // recreate); stock is reconciled below.
      if (itemsProvided) {
        await storage.deleteTransactionItems(id);
        if (editIsMultiProduct && editResolvedItems.length > 0) {
          await storage.createTransactionItems(
            editResolvedItems.map((it) => ({
              transactionId: id,
              organizationId: req.organizationId,
              productId: it.productId,
              description: it.description,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              profitabilityCodeId: it.profitabilityCodeId,
            })),
          );
        }
      }
      
      const isApproval = 
        previousStatus === 'scheduled' && 
        transaction.status === 'completed' &&
        (transaction.type === 'payable' || transaction.type === 'receivable');
      
      const skipBalance = req.body.skipBalance === true;
      if (isApproval && transaction.accountId && !skipBalance) {
        const amount = parseFloat(transaction.amount);
        const delta = transaction.type === 'payable' ? -amount : amount;
        await db.update(accounts)
          .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) + ${delta})` })
          .where(eq(accounts.id, transaction.accountId));
      }

      // Task #229: when a receivable created with a payment method is
      // manually marked as collected, propagate full completion to the
      // pending payable children (they get marked completed and their
      // amounts are subtracted from the account balance).
      if (isApproval && transaction.type === 'receivable' && transaction.paymentMethodId) {
        try {
          const result = await storage.propagateCollectionToPaymentMethodChildren(
            transaction.id,
            1,
            req.userId,
            transaction.id,
          );
          if (result.completedChildren.length > 0) {
            console.log(`[PaymentMethods] Auto-completed ${result.completedChildren.length} child cost(s) on receivable ${transaction.id} approval`);
          }
        } catch (propErr) {
          console.error('[PaymentMethods] Error propagating to payment-method children on approval:', propErr);
        }
      }

      // T002: Balance reconciliation when editing amount/account/type on already-completed transactions
      // Only runs if transaction was already completed (not an approval transition)
      const wasAlreadyCompletedForBalance = previousStatus === 'completed' && transaction.status === 'completed' && !isApproval;
      const balanceFieldsChanged = 'amount' in updates || 'accountId' in updates || 'type' in updates;
      if (wasAlreadyCompletedForBalance && balanceFieldsChanged && !skipBalance) {
        const oldAmount = parseFloat(currentTx.amount);
        const oldIsPositive = currentTx.type === 'income' || currentTx.type === 'transfer_in' || currentTx.type === 'receivable';
        const oldDelta = oldIsPositive ? oldAmount : -oldAmount;

        const newAmount = parseFloat(transaction.amount);
        const newIsPositive = transaction.type === 'income' || transaction.type === 'transfer_in' || transaction.type === 'receivable';
        const newDelta = newIsPositive ? newAmount : -newAmount;

        // Reverse old impact on old account
        if (currentTx.accountId) {
          await db.update(accounts)
            .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) + ${-oldDelta})` })
            .where(eq(accounts.id, currentTx.accountId));
        }

        // Apply new impact on new account (might be same or different account)
        if (transaction.accountId) {
          await db.update(accounts)
            .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) + ${newDelta})` })
            .where(eq(accounts.id, transaction.accountId));
        }
      }
      
      let createdNextInstanceId: string | null = null;
      // If this is a recurring transaction, create the next scheduled commitment
      if (isApproval && transaction.isRecurring && transaction.recurrenceFrequency) {
        const frequency = transaction.recurrenceFrequency;
        const currentDueDate = new Date(transaction.date);
        // Task #353: closed-series gating. If the user set a total number of
        // installments (N) and this confirmation is the N-th (or later), do
        // NOT generate the next scheduled instance. `recurrenceTotalInstallments`
        // null = infinite (legacy behavior); current defaults to 1 when the
        // counter wasn't initialized on legacy rows.
        const totalInstallments = (transaction as any).recurrenceTotalInstallments as number | null | undefined;
        const currentInstallment = ((transaction as any).recurrenceCurrentInstallment as number | null | undefined) ?? 1;
        if (totalInstallments != null && currentInstallment >= totalInstallments) {
          console.log(`[Recurrence] Series complete (${currentInstallment}/${totalInstallments}). Skipping next ${frequency} commitment.`);
          // Skip the entire block.
        } else {
        
        const advanceDate = (d: Date, freq: string): Date => {
          const next = new Date(d);
          switch (freq) {
            case 'weekly': next.setDate(next.getDate() + 7); break;
            case 'biweekly': next.setDate(next.getDate() + 14); break;
            case 'monthly': next.setMonth(next.getMonth() + 1); break;
            case 'quarterly': next.setMonth(next.getMonth() + 3); break;
            case 'yearly': next.setFullYear(next.getFullYear() + 1); break;
            default: next.setMonth(next.getMonth() + 1);
          }
          return next;
        };

        let nextDueDate = advanceDate(currentDueDate, frequency);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        while (nextDueDate < today) {
          nextDueDate = advanceDate(nextDueDate, frequency);
        }

        const sourceId = transaction.recurrenceSourceId || transaction.id;

        const existingDuplicates = await db
          .select({ id: transactions.id })
          .from(transactions)
          .where(and(
            eq(transactions.organizationId, transaction.organizationId),
            eq(transactions.status, 'scheduled'),
            eq(transactions.isRecurring, true),
            eq(transactions.type, transaction.type),
            sql`${transactions.recurrenceSourceId} = ${sourceId}`,
            sql`ABS(EXTRACT(EPOCH FROM (${transactions.date}::timestamp - ${nextDueDate.toISOString()}::timestamp))) < 86400`
          ))
          .limit(1);

        if (existingDuplicates.length === 0) {
          // Task #475: propagate multi-product line items to the generated
          // commitment so its later approval adjusts stock per line. Multi-
          // product children must carry null legacy productId/productQuantity.
          const srcItems = await storage.getTransactionItems(transaction.id);
          const isMulti = srcItems.length > 0;
          const nextInstance = await storage.createTransaction({
            type: transaction.type,
            amount: transaction.amount,
            currency: transaction.currency,
            description: transaction.description,
            category: transaction.category,
            date: nextDueDate,
            imputationDate: nextDueDate,
            accountId: transaction.accountId,
            organizationId: transaction.organizationId,
            createdBy: req.userId,
            hasInvoice: false,
            status: 'scheduled',
            clientId: transaction.clientId,
            supplierId: transaction.supplierId,
            productId: isMulti ? null : transaction.productId,
            productQuantity: isMulti ? null : transaction.productQuantity,
            isRecurring: true,
            recurrenceFrequency: frequency,
            recurrenceSourceId: sourceId,
            // Task #353: propagate the closed-series counter forward.
            recurrenceTotalInstallments: totalInstallments ?? null,
            recurrenceCurrentInstallment:
              totalInstallments != null ? currentInstallment + 1 : null,
          });
          if (isMulti) {
            await storage.createTransactionItems(srcItems.map((it) => ({
              transactionId: nextInstance.id,
              organizationId: transaction.organizationId,
              productId: it.productId,
              description: it.description,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              profitabilityCodeId: it.profitabilityCodeId,
            })));
          }
          createdNextInstanceId = nextInstance.id;
          console.log(`[Recurrence] Created next ${frequency} commitment for ${nextDueDate.toISOString()}${totalInstallments != null ? ` (installment ${currentInstallment + 1}/${totalInstallments})` : ''}`);
        } else {
          // Task #353: reconciliar contadores en la fila duplicada existente
          // para evitar deriva ("stale counter") cuando viene de un legacy
          // sin total/current o de una serie pre-feature. Sólo reescribimos
          // si la transacción actual está en una serie cerrada (total != null).
          const dupe = existingDuplicates[0];
          if (totalInstallments != null) {
            const expectedCurrent = currentInstallment + 1;
            const needsUpdate =
              (dupe as any).recurrenceTotalInstallments !== totalInstallments ||
              (dupe as any).recurrenceCurrentInstallment !== expectedCurrent;
            if (needsUpdate) {
              try {
                await storage.updateTransaction(dupe.id, {
                  recurrenceTotalInstallments: totalInstallments,
                  recurrenceCurrentInstallment: expectedCurrent,
                } as any);
                console.log(`[Recurrence] Reconciled duplicate counters on ${dupe.id} to ${expectedCurrent}/${totalInstallments}`);
              } catch (e: any) {
                console.error('[Recurrence] Failed to reconcile duplicate counters:', e?.message || e);
              }
            }
          }
          console.log(`[Recurrence] Skipped duplicate: ${frequency} commitment already exists near ${nextDueDate.toISOString()}`);
        }
        } // end of closed-series gating else
      }
      
      if (willBeCompleted) {
        try {
          const items = await storage.getTransactionItems(transaction.id);
          const lines = deriveStockLines(transaction, items);
          if (lines.length > 0) {
            const reasonLabel = transaction.type === 'expense' ? 'Compra' : transaction.type === 'income' ? 'Venta' : transaction.type === 'payable' ? 'Pago aprobado' : 'Cobro aprobado';
            await adjustStockForLines({
              lines,
              txType: transaction.type,
              direction: 'apply',
              organizationId: req.organizationId,
              userId: req.userId,
              reason: `${reasonLabel}: ${transaction.description || ''}`,
            });
          }
        } catch (stockErr) {
          console.error('[Stock] Error updating stock on transaction approval:', stockErr);
        }
      }

      // T003: Reconcile stock when product/quantity changes on an already-completed transaction.
      // When `items` is sent (Task #475), reconciliation is handled by the
      // items-aware block below; this legacy path only runs for plain single-
      // product edits.
      const wasAlreadyCompleted = previousStatus === 'completed' && transaction.status === 'completed';
      const productChanged = 'productId' in updates || 'productQuantity' in updates;
      if (wasAlreadyCompleted && productChanged && !itemsProvided) {
        try {
          const oldLines = deriveStockLines(currentTx);
          if (oldLines.length > 0) {
            await adjustStockForLines({
              lines: oldLines,
              txType: currentTx.type,
              direction: 'reverse',
              organizationId: req.organizationId,
              userId: req.userId,
              reason: `[AJUSTE] Producto/cantidad modificado: ${currentTx.description || ''}`,
            });
          }
          const newLines = deriveStockLines(transaction);
          if (newLines.length > 0) {
            await adjustStockForLines({
              lines: newLines,
              txType: transaction.type,
              direction: 'apply',
              organizationId: req.organizationId,
              userId: req.userId,
              reason: `[AJUSTE] Producto/cantidad modificado: ${transaction.description || ''}`,
            });
          }
        } catch (stockErr) {
          console.error('[Stock] Error reconciling stock on transaction edit:', stockErr);
        }
      }

      // Task #475: items-aware stock reconciliation when line items are edited
      // on an already-completed transaction. Reverse the previous effective
      // lines (from the old items / legacy snapshot) and apply the new ones, so
      // the net change matches the edit. (scheduled→completed is handled by the
      // willBeCompleted block above, which reads the freshly-persisted items.)
      if (itemsProvided && wasAlreadyCompleted) {
        try {
          const oldLines = deriveStockLines(currentTx, oldItemsForEdit);
          if (oldLines.length > 0) {
            await adjustStockForLines({
              lines: oldLines,
              txType: currentTx.type,
              direction: 'reverse',
              organizationId: req.organizationId,
              userId: req.userId,
              reason: `[AJUSTE] Renglones modificados: ${currentTx.description || ''}`,
            });
          }
          const newLines: StockLine[] = editIsMultiProduct
            ? editResolvedItems.map((it) => ({ productId: it.productId, quantity: parseFloat(it.quantity), profitabilityCodeId: it.profitabilityCodeId }))
            : deriveStockLines(transaction);
          if (newLines.length > 0) {
            await adjustStockForLines({
              lines: newLines,
              txType: transaction.type,
              direction: 'apply',
              organizationId: req.organizationId,
              userId: req.userId,
              reason: `[AJUSTE] Renglones modificados: ${transaction.description || ''}`,
            });
          }
        } catch (stockErr) {
          console.error('[Stock] Error reconciling multi-product stock on edit:', stockErr);
        }
      }

      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'transaction',
        entityId: id,
        action: 'update',
        previousData: JSON.stringify(currentTx),
        newData: JSON.stringify(transaction),
      });
      
      const wasOriginallyPayment = currentTx.type === 'expense' || currentTx.type === 'income';
      if (willBeCompleted && wasOriginallyPayment && (transaction.type === 'expense' || transaction.type === 'income')) {
        const entityType = transaction.type === 'expense' ? 'supplier' : 'client';
        const entityId = transaction.type === 'expense' ? transaction.supplierId : transaction.clientId;
        if (entityId) {
          try {
            const result = await autoApplyPaymentToCommitments({
              paymentAmount: parseFloat(transaction.amount),
              currency: transaction.currency || 'ARS',
              organizationId: req.organizationId,
              userId: req.userId,
              entityType: entityType as 'supplier' | 'client',
              entityId,
              paymentTransactionId: transaction.id,
            });
            if (result.appliedCount > 0) {
              console.log(`[AutoApply] PATCH: Applied payment ${transaction.id} to ${result.appliedCount} commitment(s), total: ${result.appliedTotal}`);
            }
          } catch (autoApplyErr) {
            console.error('[AutoApply] Error on PATCH auto-apply:', autoApplyErr);
          }
        }
      }

      let undoKey: string | undefined;
      if (isApproval) {
        undoKey = stashForUndo('transaction_approved', id, {
          previousTransaction: currentTx,
          balanceDelta: (!skipBalance && transaction.accountId) ? (transaction.type === 'payable' ? -parseFloat(transaction.amount) : parseFloat(transaction.amount)) : 0,
          accountId: transaction.accountId,
          createdNextInstanceId,
        }, req.organizationId, req.userId);
      }

      res.json({ ...transaction, undoKey });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  // Task #348 — Bulk delete de movimientos. Mismas reglas que el endpoint
  // individual: omite CANCELACIÓN y movimientos con CAE (facturados),
  // cascadea hijos de medio de pago, elimina pareadas (transferencias),
  // revierte stock y compromisos auto-aplicados, todo best-effort por id.
  // No usa el sistema de undo (fuera de scope) — los borrados quedan en
  // audit log igual.
  app.post('/api/transactions/bulk-delete', requireAuth, requirePermission('transactions:delete'), async (req: any, res) => {
    try {
      const role = req.membership?.role;
      if (role !== 'owner' && role !== 'admin') {
        return res.status(403).json({
          message: 'Solo dueño o administrador pueden eliminar movimientos en bloque',
          code: 'FORBIDDEN_ROLE',
          userRole: role,
        });
      }
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: 'Debés enviar al menos un id' });
      }
      if (ids.length > 200) {
        return res.status(400).json({ message: 'No podés eliminar más de 200 movimientos en una sola operación' });
      }
      if (!ids.every((id: any) => typeof id === 'string' && id.length > 0)) {
        return res.status(400).json({ message: 'Lista de ids inválida' });
      }

      const uniqueIds = Array.from(new Set(ids as string[]));
      const deleted: string[] = [];
      const skipped: { id: string; reason: string }[] = [];
      const alreadyProcessed = new Set<string>();

      for (const id of uniqueIds) {
        if (alreadyProcessed.has(id)) {
          skipped.push({ id, reason: 'already_processed' });
          continue;
        }
        try {
          const tx = await storage.getTransaction(id);
          if (!tx || tx.organizationId !== req.organizationId) {
            skipped.push({ id, reason: 'not_found' });
            continue;
          }
          // Capture line items before deletion (cascade removes them).
          const txItemsForStock = await storage.getTransactionItems(id);
          if (tx.description?.startsWith('[CANCELACIÓN]')) {
            skipped.push({ id, reason: 'cancellation' });
            continue;
          }
          if ((tx as any).invoiceCae) {
            skipped.push({ id, reason: 'invoiced' });
            continue;
          }

          // Revertir compromisos auto-aplicados (best-effort)
          if ((tx.type === 'expense' || tx.type === 'income') && tx.status === 'completed') {
            try {
              const autoAppliedLogs = await db.select().from(auditLogs).where(
                and(
                  eq(auditLogs.organizationId, req.organizationId),
                  eq(auditLogs.entityType, 'transaction'),
                  sql`${auditLogs.action} IN ('auto_apply_complete', 'auto_apply_partial')`,
                  sql`${auditLogs.newData}::jsonb->>'appliedByTransactionId' = ${id}`,
                )
              );
              for (const log of autoAppliedLogs) {
                const prevData = log.previousData ? JSON.parse(log.previousData) : null;
                if (!prevData) continue;
                const curr = await db.select().from(transactions).where(eq(transactions.id, log.entityId)).limit(1);
                if (!curr.length) continue;
                if (curr[0].autoAppliedByTransactionId !== id) continue;
                if (log.action === 'auto_apply_complete') {
                  await db.update(transactions).set({
                    status: prevData.status || 'scheduled',
                    completedBy: null,
                    completedAt: null,
                    autoAppliedByTransactionId: null,
                  }).where(eq(transactions.id, log.entityId));
                } else if (log.action === 'auto_apply_partial') {
                  const wasFirstPartial = String(prevData.amount) === String(prevData.originalAmount);
                  await db.update(transactions).set({
                    amount: String(prevData.amount),
                    autoAppliedByTransactionId: null,
                    originalAmount: wasFirstPartial ? null : (prevData.originalAmount || null),
                  }).where(eq(transactions.id, log.entityId));
                }
              }
            } catch (autoErr) {
              console.error('[BulkDelete] autoApply undo error:', autoErr);
            }
          }

          // Pareada (transferencia)
          let pairedTransaction: any = null;
          if (tx.transferPairId && (tx.type === 'transfer_in' || tx.type === 'transfer_out')) {
            const allOrgTx = await storage.getTransactionsByOrganization(req.organizationId);
            pairedTransaction = allOrgTx.find(t => t.transferPairId === tx.transferPairId && t.id !== id) || null;
          }

          // Cascada hijos por medio de pago
          let paymentMethodChildren: Awaited<ReturnType<typeof storage.getPaymentMethodChildren>> = [];
          if (tx.paymentMethodId) {
            paymentMethodChildren = await storage.getPaymentMethodChildren(id);
          }
          let childCascadeFailed = false;
          for (const child of paymentMethodChildren) {
            const r = await storage.deleteTransaction(child.id);
            if (!r.deleted) { childCascadeFailed = true; break; }
            await storage.createAuditLog({
              organizationId: req.organizationId,
              userId: req.userId,
              entityType: 'transaction',
              entityId: child.id,
              action: 'cascade_delete_payment_method_child',
              previousData: JSON.stringify(child),
              newData: JSON.stringify({ parentId: id }),
            });
            alreadyProcessed.add(child.id);
          }
          if (childCascadeFailed) {
            skipped.push({ id, reason: 'child_failed' });
            continue;
          }

          const result = await storage.deleteTransaction(id);
          if (!result.deleted) {
            skipped.push({ id, reason: 'delete_failed' });
            continue;
          }
          alreadyProcessed.add(id);

          if (pairedTransaction) {
            const pairedResult = await storage.deleteTransaction(pairedTransaction.id);
            if (pairedResult.deleted) {
              alreadyProcessed.add(pairedTransaction.id);
              await storage.createAuditLog({
                organizationId: req.organizationId,
                userId: req.userId,
                entityType: 'transaction',
                entityId: pairedTransaction.id,
                action: 'delete',
                previousData: JSON.stringify(pairedTransaction),
                newData: null,
              });
            } else {
              skipped.push({ id: pairedTransaction.id, reason: 'pair_delete_failed' });
            }
          }

          await storage.createAuditLog({
            organizationId: req.organizationId,
            userId: req.userId,
            entityType: 'transaction',
            entityId: id,
            action: 'delete',
            previousData: JSON.stringify(tx),
            newData: null,
          });

          // Revertir stock si correspondía
          const wasCompleted = tx.status === 'completed';
          if (wasCompleted) {
            try {
              const lines = deriveStockLines(tx, txItemsForStock);
              if (lines.length > 0) {
                await adjustStockForLines({
                  lines,
                  txType: tx.type,
                  direction: 'reverse',
                  organizationId: req.organizationId,
                  userId: req.userId,
                  reason: `[CANCELACIÓN] ${tx.description || ''}`,
                });
              }
            } catch (stockErr) {
              console.error('[BulkDelete] stock reversal error:', stockErr);
            }
          }

          deleted.push(id);
        } catch (itemErr: any) {
          console.error(`[BulkDelete] error on ${id}:`, itemErr);
          skipped.push({ id, reason: 'error' });
        }
      }

      res.json({ deleted, skipped });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.delete('/api/transactions/:id', requireAuth, requirePermission('transactions:delete'), async (req: any, res) => {
    try {
      const { id } = req.params;
      
      const transactionToDelete = await storage.getTransaction(id);
      
      if (transactionToDelete && transactionToDelete.description?.startsWith('[CANCELACIÓN]')) {
        return res.status(400).json({ message: 'Este movimiento es un registro de cancelación y no puede modificarse. Es parte del historial de tu cuenta.' });
      }

      // Capture line items before deletion (cascade removes them) so undo can
      // restore both the rows and the stock movements.
      const itemsToDelete = transactionToDelete ? await storage.getTransactionItems(id) : [];

      let undoKey: string | undefined;
      if (transactionToDelete) {
        undoKey = stashForUndo('transaction', id, { ...transactionToDelete, _items: itemsToDelete }, req.organizationId, req.userId);
      }

      if (transactionToDelete && (transactionToDelete.type === 'expense' || transactionToDelete.type === 'income') && transactionToDelete.status === 'completed') {
        try {
          const autoAppliedLogs = await db.select().from(auditLogs).where(
            and(
              eq(auditLogs.organizationId, req.organizationId),
              eq(auditLogs.entityType, 'transaction'),
              sql`${auditLogs.action} IN ('auto_apply_complete', 'auto_apply_partial')`,
              sql`${auditLogs.newData}::jsonb->>'appliedByTransactionId' = ${id}`,
            )
          );

          const reversedLogs: typeof autoAppliedLogs = [];
          for (const log of autoAppliedLogs) {
            const prevData = log.previousData ? JSON.parse(log.previousData) : null;
            if (!prevData) continue;

            const currentCommitment = await db.select().from(transactions).where(eq(transactions.id, log.entityId)).limit(1);
            if (!currentCommitment.length) continue;
            const curr = currentCommitment[0];

            if (curr.autoAppliedByTransactionId !== id) {
              console.log(`[AutoApply Undo] Skipping ${log.entityId}: autoAppliedByTransactionId=${curr.autoAppliedByTransactionId} !== ${id} (commitment was modified by another payment)`);
              continue;
            }

            if (log.action === 'auto_apply_complete') {
              await db.update(transactions).set({
                status: prevData.status || 'scheduled',
                completedBy: null,
                completedAt: null,
                autoAppliedByTransactionId: null,
              }).where(eq(transactions.id, log.entityId));
              console.log(`[AutoApply Undo] Restored commitment ${log.entityId} to status=${prevData.status || 'scheduled'}`);
            } else if (log.action === 'auto_apply_partial') {
              const restoredAmount = prevData.amount;
              const wasFirstPartial = String(prevData.amount) === String(prevData.originalAmount);
              await db.update(transactions).set({
                amount: String(restoredAmount),
                autoAppliedByTransactionId: null,
                originalAmount: wasFirstPartial ? null : (prevData.originalAmount || null),
              }).where(eq(transactions.id, log.entityId));
              console.log(`[AutoApply Undo] Restored commitment ${log.entityId} amount to ${restoredAmount}`);
            }
            reversedLogs.push(log);
          }

          if (reversedLogs.length > 0 && undoKey) {
            updateStashData(undoKey, (d) => ({ ...d, _autoApplyReversed: reversedLogs.map(l => ({ entityId: l.entityId, action: l.action, previousData: l.previousData, newData: l.newData })) }));
          }
        } catch (autoUndoErr) {
          console.error('[AutoApply Undo] Error reversing auto-applied commitments:', autoUndoErr);
        }
      }

      // T006: If this is part of a transfer pair, also delete the other side
      let pairedTransaction: any = null;
      if (transactionToDelete?.transferPairId && (transactionToDelete.type === 'transfer_in' || transactionToDelete.type === 'transfer_out')) {
        const allOrgTx = await storage.getTransactionsByOrganization(req.organizationId);
        pairedTransaction = allOrgTx.find(t => 
          t.transferPairId === transactionToDelete.transferPairId && t.id !== id
        );
      }

      // Task #229: cascade-delete payment-method children before deleting
      // the parent. We fail-fast on any child error: if even one child
      // cannot be deleted we abort the whole operation so we never end up
      // with a deleted parent and orphaned/inconsistent children. Note that
      // storage.deleteTransaction is itself responsible for balance
      // reversal and inverse-record creation per child.
      let paymentMethodChildren: Awaited<ReturnType<typeof storage.getPaymentMethodChildren>> = [];
      if (transactionToDelete && transactionToDelete.paymentMethodId) {
        paymentMethodChildren = await storage.getPaymentMethodChildren(id);
      }
      for (const child of paymentMethodChildren) {
        const result = await storage.deleteTransaction(child.id);
        if (!result.deleted) {
          return res.status(500).json({
            message: `No se pudo eliminar el costo asociado ${child.transactionNumber || child.id}. La operación fue cancelada para mantener la consistencia de los saldos.`,
          });
        }
        await storage.createAuditLog({
          organizationId: req.organizationId,
          userId: req.userId,
          entityType: 'transaction',
          entityId: child.id,
          action: 'cascade_delete_payment_method_child',
          previousData: JSON.stringify(child),
          newData: JSON.stringify({ parentId: id }),
        });
      }

      const deleteResult = await storage.deleteTransaction(id);
      if (!deleteResult.deleted) {
        return res.status(404).json({ message: 'Transaction not found' });
      }

      if (undoKey && deleteResult.cancellationId) {
        updateStashData(undoKey, (d) => ({ ...d, _cancellationId: deleteResult.cancellationId }));
      }

      if (pairedTransaction) {
        const pairedResult = await storage.deleteTransaction(pairedTransaction.id);
        if (undoKey && pairedResult.cancellationId) {
          updateStashData(undoKey, (d) => ({
            ...d,
            _pairedTransaction: pairedTransaction,
            _pairedCancellationId: pairedResult.cancellationId,
          }));
        }
        await storage.createAuditLog({
          organizationId: req.organizationId,
          userId: req.userId,
          entityType: 'transaction',
          entityId: pairedTransaction.id,
          action: 'delete',
          previousData: JSON.stringify(pairedTransaction),
          newData: null,
        });
      }
      
      if (transactionToDelete) {
        await storage.createAuditLog({
          organizationId: req.organizationId,
          userId: req.userId,
          entityType: 'transaction',
          entityId: id,
          action: 'delete',
          previousData: JSON.stringify(transactionToDelete),
          newData: null,
        });

        const wasCompleted = transactionToDelete.status === 'completed';
        if (wasCompleted) {
          try {
            const lines = deriveStockLines(transactionToDelete, itemsToDelete);
            if (lines.length > 0) {
              await adjustStockForLines({
                lines,
                txType: transactionToDelete.type,
                direction: 'reverse',
                organizationId: req.organizationId,
                userId: req.userId,
                reason: `[CANCELACIÓN] ${transactionToDelete.description || ''}`,
              });
            }
          } catch (stockErr) {
            console.error('[Stock] Error reversing stock from cancelled transaction:', stockErr);
          }
        }
      }
      
      res.json({ message: 'Transaction deleted', undoKey });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Get transactions linked to a specific transaction
  app.get('/api/transactions/:id/linked', requireAuth, async (req: any, res) => {
    try {
      const { id } = req.params;
      const transactions = await storage.getTransactionsByOrganization(req.organizationId);
      
      // Find the parent transaction
      const parent = transactions.find(tx => tx.id === id);
      if (!parent) {
        return res.status(404).json({ message: 'Transaction not found' });
      }
      
      // Find all COMPLETED transactions linked to this one
      const linked = transactions.filter(tx => 
        tx.linkedTransactionId === id && tx.status === 'completed'
      );
      
      // Calculate totals
      const linkedTotal = linked.reduce((sum, tx) => sum + parseFloat(tx.amount), 0);
      
      res.json({
        parent: {
          id: parent.id,
          transactionNumber: parent.transactionNumber,
          description: parent.description,
          amount: parent.amount,
          date: parent.date,
          type: parent.type,
          category: parent.category,
        },
        linkedTransactions: linked.map(tx => ({
          id: tx.id,
          transactionNumber: tx.transactionNumber,
          description: tx.description,
          amount: tx.amount,
          date: tx.date,
          type: tx.type,
          category: tx.category,
        })),
        summary: {
          originalAmount: parseFloat(parent.amount),
          linkedAmount: linkedTotal,
          availableBalance: parseFloat(parent.amount) - linkedTotal,
        },
      });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  // Get full traceability tree for a transaction
  app.get('/api/transactions/:id/traceability', requireAuth, async (req: any, res) => {
    try {
      const { id } = req.params;
      const transactions = await storage.getTransactionsByOrganization(req.organizationId);
      
      // Find the transaction
      let rootId = id;
      let current = transactions.find(tx => tx.id === id);
      
      if (!current) {
        return res.status(404).json({ message: 'Transaction not found' });
      }
      
      // If this transaction has a parent, find the root
      while (current?.linkedTransactionId) {
        rootId = current.linkedTransactionId;
        current = transactions.find(tx => tx.id === rootId);
      }
      
      const root = transactions.find(tx => tx.id === rootId);
      if (!root) {
        return res.status(404).json({ message: 'Root transaction not found' });
      }
      
      // Helper to calculate total amount of all descendants (only completed)
      const calculateDescendantsTotal = (parentId: string): number => {
        const children = transactions.filter(tx => 
          tx.linkedTransactionId === parentId && tx.status === 'completed'
        );
        return children.reduce((sum, child) => 
          sum + parseFloat(child.amount) + calculateDescendantsTotal(child.id), 0
        );
      };
      
      // Build the tree (only completed transactions)
      const buildTree = (parentId: string): any[] => {
        const children = transactions.filter(tx => 
          tx.linkedTransactionId === parentId && tx.status === 'completed'
        );
        return children.map(child => ({
          id: child.id,
          transactionNumber: child.transactionNumber,
          description: child.description,
          amount: child.amount,
          date: child.date,
          type: child.type,
          category: child.category,
          children: buildTree(child.id),
        }));
      };
      
      const usedTotal = calculateDescendantsTotal(rootId);
      
      res.json({
        root: {
          id: root.id,
          transactionNumber: root.transactionNumber,
          description: root.description,
          amount: root.amount,
          date: root.date,
          type: root.type,
          category: root.category,
        },
        children: buildTree(rootId),
        summary: {
          originalAmount: parseFloat(root.amount),
          usedAmount: usedTotal,
          availableBalance: parseFloat(root.amount) - usedTotal,
        },
      });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Get pending commitments (upcoming payables/receivables) for ALL user organizations
  app.get('/api/pending-commitments', requireAuth, async (req: any, res) => {
    try {
      // Get all organizations the user belongs to
      const userOrgs = await storage.getOrganizationsByUser(req.userId);
      const now = new Date();
      const warningDays = 7; // Notify 7 days before due date
      
      // Get all user-clicked notifications to filter out already-clicked items
      // Only filter by notifications with source='user_click', not auto-generated ones
      const allPersistentNotifications = await storage.getNotificationsByUser(req.userId, undefined, true);
      const clickedTransactionIds = new Set(
        allPersistentNotifications
          .filter(n => n.transactionId && n.source === 'user_click')
          .map(n => n.transactionId)
      );
      
      const notifications: Array<{
        id: string;
        type: 'payable' | 'receivable';
        title: string;
        description: string;
        amount: string;
        currency: string;
        dueDate: string;
        daysUntilDue: number;
        priority: 'urgent' | 'warning' | 'info';
        organizationId: string;
        organizationName: string;
      }> = [];

      // Fetch transactions from all user organizations
      for (const org of userOrgs) {
        const transactions = await storage.getTransactionsByOrganization(org.id);
        
        for (const tx of transactions) {
          // Only pending or scheduled payables or receivables, and not already clicked
          if ((tx.type === 'payable' || tx.type === 'receivable') && tx.status === 'scheduled' && !clickedTransactionIds.has(tx.id)) {
            const dueDate = tx.imputationDate ? new Date(tx.imputationDate) : new Date(tx.date);
            // Adjust to Argentina timezone (UTC-3) for accurate date comparison
            // This ensures dates displayed to users match notification calculations
            const argentinaOffset = -3 * 60 * 60 * 1000; // -3 hours in ms
            const dueDateArg = new Date(dueDate.getTime() + argentinaOffset);
            const nowArg = new Date(now.getTime() + argentinaOffset);
            // Normalize to start of day in Argentina timezone
            const dueDateNorm = new Date(Date.UTC(dueDateArg.getUTCFullYear(), dueDateArg.getUTCMonth(), dueDateArg.getUTCDate()));
            const nowNorm = new Date(Date.UTC(nowArg.getUTCFullYear(), nowArg.getUTCMonth(), nowArg.getUTCDate()));
            const diffTime = dueDateNorm.getTime() - nowNorm.getTime();
            const daysUntilDue = Math.round(diffTime / (1000 * 60 * 60 * 24));
            
            // Include if due within warning period or overdue
            if (daysUntilDue <= warningDays) {
              let priority: 'urgent' | 'warning' | 'info' = 'info';
              let title = '';
              
              if (daysUntilDue < 0) {
                priority = 'urgent';
                title = tx.type === 'payable' ? `Pago vencido hace ${Math.abs(daysUntilDue)} días` : `Cobro vencido hace ${Math.abs(daysUntilDue)} días`;
              } else if (daysUntilDue <= 2) {
                priority = 'urgent';
                title = tx.type === 'payable' ? `Pago vence ${daysUntilDue === 0 ? 'hoy' : daysUntilDue === 1 ? 'mañana' : `en ${daysUntilDue} días`}` : `Cobro vence ${daysUntilDue === 0 ? 'hoy' : daysUntilDue === 1 ? 'mañana' : `en ${daysUntilDue} días`}`;
              } else {
                priority = 'warning';
                title = tx.type === 'payable' ? `Pago en ${daysUntilDue} días` : `Cobro en ${daysUntilDue} días`;
              }
              
              notifications.push({
                id: tx.id,
                type: tx.type as 'payable' | 'receivable',
                title,
                description: tx.description ?? 'Sin descripción',
                amount: tx.amount,
                currency: tx.currency ?? 'ARS',
                dueDate: dueDate.toISOString(),
                daysUntilDue,
                priority,
                organizationId: org.id,
                organizationName: org.name,
              });
            }
          }
        }
      }

      // Sort by priority (urgent first) then by days until due
      notifications.sort((a, b) => {
        const priorityOrder = { urgent: 0, warning: 1, info: 2 };
        if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
          return priorityOrder[a.priority] - priorityOrder[b.priority];
        }
        return a.daysUntilDue - b.daysUntilDue;
      });

      res.json({
        notifications,
        unreadCount: notifications.filter(n => n.priority === 'urgent').length,
        totalCount: notifications.length,
      });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
}


// Exported so the integration test in `tests/calendarTransfersEndpoint.test.ts`
// can mount the SAME handler the production route uses, without the auth/
// subscription middleware (covered separately by other tests).
export async function calendarHandler(req: any, res: any) {
    try {
      const { startDate, endDate, groupBy } = req.query;
      
      if (!startDate || !endDate) {
        return res.status(400).json({ message: 'startDate and endDate are required' });
      }
      const start = new Date(startDate as string);
      const end = new Date(endDate as string);
      
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json({ message: 'Invalid date format' });
      }
      
      // The calendar groups by `imputation_date` (the accounting date), so the
      // storage filter must use the same column to avoid cross-month leakage.
      // We also pull cancelled transactions separately by status: callers can
      // opt in via `?includeCancelled=1` to render them tachadas in the day list.
      // Pass the full ISO timestamps verbatim so the Argentina-local boundaries
      // sent by the client (e.g. `2026-05-01T02:59:59.999Z` for end-of-April
      // ART) are preserved without being rounded up to the next UTC day.
      const includeCancelled = req.query.includeCancelled === '1' || req.query.includeCancelled === 'true';
      const allTransactions = await storage.getTransactionsByOrganization(req.organizationId, undefined, {
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        dateField: 'imputation',
      });
      const accounts = await storage.getAccountsByOrganization(req.organizationId);
      const accountsMap = new Map(accounts.map(a => [a.id, a]));

      // --- helpers ---------------------------------------------------------

      const normalizeCurrency = (currency: string | null | undefined): 'ARS' | 'USD' => {
        if (!currency) return 'ARS';
        if (currency.startsWith('USD') || currency === 'USD') return 'USD';
        return 'ARS';
      };

      // The transaction's own `currency` column is the source of truth (it
      // survives account deletion / reassignment). Fall back to the account's
      // currency only if the transaction was somehow created without one.
      const txCurrency = (tx: { currency?: string | null; account?: { currency?: string | null } | null }) =>
        normalizeCurrency(tx.currency ?? tx.account?.currency);

      // Bucket dates in Argentina time so movements registered late at night
      // (UTC-3) appear on the day the user actually saw them, not the next day
      // in UTC.
      const ARG_TZ = 'America/Argentina/Buenos_Aires';
      const dayKeyFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: ARG_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      const monthKeyFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: ARG_TZ,
        year: 'numeric',
        month: '2-digit',
      });
      const toArgDayKey = (d: Date | string) => {
        const date = typeof d === 'string' ? new Date(d) : d;
        // en-CA returns YYYY-MM-DD already
        return dayKeyFormatter.format(date);
      };
      const toArgMonthKey = (d: Date | string) => {
        const date = typeof d === 'string' ? new Date(d) : d;
        // en-CA returns YYYY-MM (no day)
        return monthKeyFormatter.format(date);
      };

      // --- enrichment + filtering ------------------------------------------

      type TransferCounterpart = {
        accountId: string | null;
        account: { id: string; name: string; currency: string } | null;
      } | null;
      const enrichedAll = allTransactions.map(tx => ({
        ...tx,
        account: tx.accountId ? accountsMap.get(tx.accountId) ?? null : null,
        effectiveDate: tx.imputationDate || tx.date,
        transferCounterpart: null as TransferCounterpart,
      }));
      type EnrichedTx = (typeof enrichedAll)[number];

      // Internal account-to-account transfers (`transfer_in`/`transfer_out`)
      // do not represent real income or expense — they MUST NOT affect any
      // money total in the calendar (real or comprometido). They are still
      // surfaced in the day list with a "Transferencia" badge so the user can
      // audit where the money moved, but they are deduped by `transferPairId`
      // so each move counts as a single entry instead of two.
      const transferTxAll = enrichedAll.filter(
        t => t.type === 'transfer_in' || t.type === 'transfer_out',
      );
      const nonTransferTx = enrichedAll.filter(
        t => t.type !== 'transfer_in' && t.type !== 'transfer_out',
      );

      // Cancelled originals AND their inverse mirror entries are excluded
      // from totals; kept in the per-day list (when requested) for audit.
      const liveTx = nonTransferTx.filter(
        t => t.status !== 'cancelled' && !isCancellationEntry(t),
      );
      const cancelledTx = nonTransferTx.filter(
        t => t.status === 'cancelled' || isCancellationEntry(t),
      );

      // Build the deduped transfer list. Cancelled transfers are dropped
      // entirely (no badge, no count). For each pair we keep ONE canonical
      // entry, preferring the `transfer_out` side so the displayed account is
      // the origin; we attach the destination account as
      // `transferCounterpart` so the UI can render "origen → destino".
      //
      // Orphan detection: an internal transfer should always have BOTH legs
      // (`transfer_in` + `transfer_out`). If only one leg survives — either
      // because the row was created without `transferPairId` (legacy bug) or
      // because its counterpart was deleted manually — the money silently
      // "disappears" from the cashflow because internal transfers are excluded
      // from totals. We surface a count (`orphanTransfers`) on the summary so
      // the UI can warn the user, and we log each orphan with enough context
      // to alert. For single-leg pairs we additionally query the DB for the
      // missing counterpart (it might just live outside the queried window);
      // only pairs with no counterpart anywhere are reported as orphans.
      // Also exclude `[CANCELACIÓN]` mirror rows. `storage.deleteTransaction`
      // creates them with type='transfer_in/transfer_out' and no `transferPairId`,
      // so without this filter every cancelled transfer would silently inflate
      // the orphan count here while the listing endpoint
      // (`GET /api/transactions/orphan-transfers`, which uses `isCancellationEntry`)
      // would NOT show them — the banner counter would never match the listed
      // rows in `/orphan-transfers`. See task #177.
      const liveTransfers = transferTxAll.filter(
        t => t.status !== 'cancelled' && !isCancellationEntry(t),
      );
      const transfersByPair = new Map<string, EnrichedTx[]>();
      const noPairIdOrphans: EnrichedTx[] = [];
      for (const t of liveTransfers) {
        if (!t.transferPairId) {
          noPairIdOrphans.push(t);
          continue;
        }
        const arr = transfersByPair.get(t.transferPairId) ?? [];
        arr.push(t);
        transfersByPair.set(t.transferPairId, arr);
      }

      // Confirm single-leg pairs against the full transactions table — the
      // counterpart may simply fall outside [startDate, endDate].
      const singleLegPairIds = Array.from(transfersByPair.entries())
        .filter(([, arr]) => arr.length < 2)
        .map(([pairId]) => pairId);
      const confirmedOrphanPairIds = new Set<string>();
      if (singleLegPairIds.length > 0) {
        try {
          const counterparts = await db
            .select({
              id: transactions.id,
              type: transactions.type,
              transferPairId: transactions.transferPairId,
              status: transactions.status,
            })
            .from(transactions)
            .where(
              and(
                eq(transactions.organizationId, req.organizationId),
                inArray(transactions.transferPairId, singleLegPairIds),
              ),
            );
          const seenByPair = new Map<string, Set<string>>();
          for (const row of counterparts) {
            if (!row.transferPairId) continue;
            if (row.status === 'cancelled') continue;
            const set = seenByPair.get(row.transferPairId) ?? new Set<string>();
            set.add(row.type);
            seenByPair.set(row.transferPairId, set);
          }
          for (const pairId of singleLegPairIds) {
            const types = seenByPair.get(pairId);
            if (!types || !types.has('transfer_in') || !types.has('transfer_out')) {
              confirmedOrphanPairIds.add(pairId);
            }
          }
        } catch (orphanErr) {
          console.error('[Calendar] Error confirming orphan transfer counterparts:', orphanErr);
          // Be conservative on lookup failure: assume in-window single legs are orphans
          for (const pairId of singleLegPairIds) confirmedOrphanPairIds.add(pairId);
        }
      }

      const singleLegOrphans: EnrichedTx[] = [];
      Array.from(confirmedOrphanPairIds).forEach(pairId => {
        const pair = transfersByPair.get(pairId);
        if (pair) singleLegOrphans.push(...pair);
      });

      const orphanTransferEntries: EnrichedTx[] = [...noPairIdOrphans, ...singleLegOrphans];
      const orphanTransferIds = Array.from(new Set(orphanTransferEntries.map(o => o.id)));
      if (orphanTransferEntries.length > 0) {
        for (const o of orphanTransferEntries) {
          console.warn('[Calendar] Orphan internal transfer detected', {
            organizationId: req.organizationId,
            transactionId: o.id,
            transactionNumber: o.transactionNumber,
            type: o.type,
            amount: o.amount,
            currency: o.currency,
            accountId: o.accountId,
            accountName: o.account?.name ?? null,
            transferPairId: o.transferPairId,
            date: o.date,
            imputationDate: o.imputationDate,
            reason: o.transferPairId ? 'missing_counterpart' : 'no_pair_id',
          });
        }
      }

      const dedupedTransfers: EnrichedTx[] = [
        ...noPairIdOrphans,
        ...Array.from(transfersByPair.values()).map<EnrichedTx>(pair => {
          const out = pair.find(p => p.type === 'transfer_out');
          const inn = pair.find(p => p.type === 'transfer_in');
          const canonical = out ?? pair[0];
          const counterpartTx = canonical === out ? inn : pair.find(p => p.id !== canonical.id);
          const counterpart: TransferCounterpart = counterpartTx
            ? {
                accountId: counterpartTx.accountId,
                account: counterpartTx.account
                  ? { id: counterpartTx.account.id, name: counterpartTx.account.name, currency: counterpartTx.account.currency }
                  : null,
              }
            : null;
          return { ...canonical, transferCounterpart: counterpart };
        }),
      ];

      // Group by date if requested
      if (groupBy === 'day') {
        const grouped: Record<string, {
          date: string;
          transactions: typeof enrichedAll;
          totalIncomeARS: number;
          totalIncomeUSD: number;
          totalExpenseARS: number;
          totalExpenseUSD: number;
          totalReceivableARS: number;
          totalReceivableUSD: number;
          totalPayableARS: number;
          totalPayableUSD: number;
          pendingIncomeARS: number;
          pendingIncomeUSD: number;
          pendingExpenseARS: number;
          pendingExpenseUSD: number;
          pendingReceivableARS: number;
          pendingReceivableUSD: number;
          pendingPayableARS: number;
          pendingPayableUSD: number;
          count: number;
          pendingCount: number;
          cancelledCount: number;
          transferCount: number;
          hasPending: boolean;
        }> = {};

        const ensureBucket = (dateKey: string) => {
          if (!grouped[dateKey]) {
            grouped[dateKey] = {
              date: dateKey,
              transactions: [],
              totalIncomeARS: 0, totalIncomeUSD: 0,
              totalExpenseARS: 0, totalExpenseUSD: 0,
              totalReceivableARS: 0, totalReceivableUSD: 0,
              totalPayableARS: 0, totalPayableUSD: 0,
              pendingIncomeARS: 0, pendingIncomeUSD: 0,
              pendingExpenseARS: 0, pendingExpenseUSD: 0,
              pendingReceivableARS: 0, pendingReceivableUSD: 0,
              pendingPayableARS: 0, pendingPayableUSD: 0,
              count: 0, pendingCount: 0, cancelledCount: 0, transferCount: 0,
              hasPending: false,
            };
          }
          return grouped[dateKey];
        };

        liveTx.forEach(tx => {
          const dateKey = toArgDayKey(tx.effectiveDate);
          const bucket = ensureBucket(dateKey);
          bucket.transactions.push(tx);
          bucket.count++;
          const amount = parseFloat(tx.amount);
          const isScheduled = tx.status === 'scheduled';
          const currency = txCurrency(tx);

          if (isScheduled) {
            bucket.pendingCount++;
            bucket.hasPending = true;
            if (tx.type === 'income') {
              if (currency === 'USD') bucket.pendingIncomeUSD += amount; else bucket.pendingIncomeARS += amount;
            } else if (tx.type === 'expense') {
              if (currency === 'USD') bucket.pendingExpenseUSD += amount; else bucket.pendingExpenseARS += amount;
            } else if (tx.type === 'receivable') {
              if (currency === 'USD') bucket.pendingReceivableUSD += amount; else bucket.pendingReceivableARS += amount;
            } else if (tx.type === 'payable') {
              if (currency === 'USD') bucket.pendingPayableUSD += amount; else bucket.pendingPayableARS += amount;
            }
          }

          if (tx.type === 'income') {
            if (currency === 'USD') bucket.totalIncomeUSD += amount; else bucket.totalIncomeARS += amount;
          } else if (tx.type === 'expense') {
            if (currency === 'USD') bucket.totalExpenseUSD += amount; else bucket.totalExpenseARS += amount;
          } else if (tx.type === 'receivable') {
            if (currency === 'USD') bucket.totalReceivableUSD += amount; else bucket.totalReceivableARS += amount;
          } else if (tx.type === 'payable') {
            if (currency === 'USD') bucket.totalPayableUSD += amount; else bucket.totalPayableARS += amount;
          }
        });

        if (includeCancelled) {
          cancelledTx.forEach(tx => {
            const dateKey = toArgDayKey(tx.effectiveDate);
            const bucket = ensureBucket(dateKey);
            bucket.transactions.push(tx);
            bucket.cancelledCount++;
          });
        }

        // Surface deduped transfers in the day list. They are NOT added to any
        // money total or to `count`; we expose `transferCount` separately so
        // the UI can show e.g. "+ 2 transferencias" without distorting the
        // existing "completados / pendientes" counts.
        dedupedTransfers.forEach(tx => {
          const dateKey = toArgDayKey(tx.effectiveDate);
          const bucket = ensureBucket(dateKey);
          bucket.transactions.push(tx);
          bucket.transferCount++;
        });

        const pendingTransactions = liveTx.filter(t => t.status === 'scheduled');

        return res.json({
          groupedByDay: Object.values(grouped).sort((a, b) => a.date.localeCompare(b.date)),
          summary: {
            totalTransactions: liveTx.length,
            cancelledTransactions: cancelledTx.length,
            transferTransactions: dedupedTransfers.length,
            orphanTransfers: orphanTransferEntries.length,
            orphanTransferIds,
            pendingTransactions: pendingTransactions.length,
            totalIncome: liveTx.filter(t => t.type === 'income').reduce((s, t) => s + parseFloat(t.amount), 0),
            totalExpense: liveTx.filter(t => t.type === 'expense').reduce((s, t) => s + parseFloat(t.amount), 0),
            totalReceivable: liveTx.filter(t => t.type === 'receivable').reduce((s, t) => s + parseFloat(t.amount), 0),
            totalPayable: liveTx.filter(t => t.type === 'payable').reduce((s, t) => s + parseFloat(t.amount), 0),
            pendingIncome: pendingTransactions.filter(t => t.type === 'income').reduce((s, t) => s + parseFloat(t.amount), 0),
            pendingExpense: pendingTransactions.filter(t => t.type === 'expense').reduce((s, t) => s + parseFloat(t.amount), 0),
          },
        });
      }

      // Group by month for year view
      if (groupBy === 'month') {
        const grouped: Record<string, {
          month: string;
          totalIncomeARS: number;
          totalIncomeUSD: number;
          totalExpenseARS: number;
          totalExpenseUSD: number;
          totalReceivableARS: number;
          totalReceivableUSD: number;
          totalPayableARS: number;
          totalPayableUSD: number;
          pendingReceivableARS: number;
          pendingReceivableUSD: number;
          pendingPayableARS: number;
          pendingPayableUSD: number;
          count: number;
          pendingCount: number;
          transferCount: number;
          hasPending: boolean;
        }> = {};

        liveTx.forEach(tx => {
          const monthKey = toArgMonthKey(tx.effectiveDate);
          if (!grouped[monthKey]) {
            grouped[monthKey] = {
              month: monthKey,
              totalIncomeARS: 0, totalIncomeUSD: 0,
              totalExpenseARS: 0, totalExpenseUSD: 0,
              totalReceivableARS: 0, totalReceivableUSD: 0,
              totalPayableARS: 0, totalPayableUSD: 0,
              pendingReceivableARS: 0, pendingReceivableUSD: 0,
              pendingPayableARS: 0, pendingPayableUSD: 0,
              count: 0, pendingCount: 0, transferCount: 0, hasPending: false,
            };
          }
          const bucket = grouped[monthKey];
          bucket.count++;
          const amount = parseFloat(tx.amount);
          const currency = txCurrency(tx);
          const isScheduled = tx.status === 'scheduled';

          if (isScheduled) {
            bucket.pendingCount++;
            bucket.hasPending = true;
            if (tx.type === 'receivable') {
              if (currency === 'USD') bucket.pendingReceivableUSD += amount; else bucket.pendingReceivableARS += amount;
            } else if (tx.type === 'payable') {
              if (currency === 'USD') bucket.pendingPayableUSD += amount; else bucket.pendingPayableARS += amount;
            }
          }

          if (tx.type === 'income') {
            if (currency === 'USD') bucket.totalIncomeUSD += amount; else bucket.totalIncomeARS += amount;
          } else if (tx.type === 'expense') {
            if (currency === 'USD') bucket.totalExpenseUSD += amount; else bucket.totalExpenseARS += amount;
          } else if (tx.type === 'receivable') {
            if (currency === 'USD') bucket.totalReceivableUSD += amount; else bucket.totalReceivableARS += amount;
          } else if (tx.type === 'payable') {
            if (currency === 'USD') bucket.totalPayableUSD += amount; else bucket.totalPayableARS += amount;
          }
        });

        // Surface deduped transfers per month — they don't move totals but
        // bump `transferCount` so the UI can hint at internal money movement.
        dedupedTransfers.forEach(tx => {
          const monthKey = toArgMonthKey(tx.effectiveDate);
          if (!grouped[monthKey]) {
            grouped[monthKey] = {
              month: monthKey,
              totalIncomeARS: 0, totalIncomeUSD: 0,
              totalExpenseARS: 0, totalExpenseUSD: 0,
              totalReceivableARS: 0, totalReceivableUSD: 0,
              totalPayableARS: 0, totalPayableUSD: 0,
              pendingReceivableARS: 0, pendingReceivableUSD: 0,
              pendingPayableARS: 0, pendingPayableUSD: 0,
              count: 0, pendingCount: 0, transferCount: 0, hasPending: false,
            };
          }
          grouped[monthKey].transferCount++;
        });

        const pendingReceivableTx = liveTx.filter(t => t.type === 'receivable' && t.status === 'scheduled');
        const pendingPayableTx = liveTx.filter(t => t.type === 'payable' && t.status === 'scheduled');

        return res.json({
          groupedByMonth: Object.values(grouped).sort((a, b) => a.month.localeCompare(b.month)),
          summary: {
            totalTransactions: liveTx.length,
            cancelledTransactions: cancelledTx.length,
            transferTransactions: dedupedTransfers.length,
            orphanTransfers: orphanTransferEntries.length,
            orphanTransferIds,
            totalIncomeARS: liveTx.filter(t => t.type === 'income' && txCurrency(t) === 'ARS').reduce((s, t) => s + parseFloat(t.amount), 0),
            totalIncomeUSD: liveTx.filter(t => t.type === 'income' && txCurrency(t) === 'USD').reduce((s, t) => s + parseFloat(t.amount), 0),
            totalExpenseARS: liveTx.filter(t => t.type === 'expense' && txCurrency(t) === 'ARS').reduce((s, t) => s + parseFloat(t.amount), 0),
            totalExpenseUSD: liveTx.filter(t => t.type === 'expense' && txCurrency(t) === 'USD').reduce((s, t) => s + parseFloat(t.amount), 0),
            totalReceivableARS: liveTx.filter(t => t.type === 'receivable' && txCurrency(t) === 'ARS').reduce((s, t) => s + parseFloat(t.amount), 0),
            totalReceivableUSD: liveTx.filter(t => t.type === 'receivable' && txCurrency(t) === 'USD').reduce((s, t) => s + parseFloat(t.amount), 0),
            totalPayableARS: liveTx.filter(t => t.type === 'payable' && txCurrency(t) === 'ARS').reduce((s, t) => s + parseFloat(t.amount), 0),
            totalPayableUSD: liveTx.filter(t => t.type === 'payable' && txCurrency(t) === 'USD').reduce((s, t) => s + parseFloat(t.amount), 0),
            pendingReceivableARS: pendingReceivableTx.filter(t => txCurrency(t) === 'ARS').reduce((s, t) => s + parseFloat(t.amount), 0),
            pendingReceivableUSD: pendingReceivableTx.filter(t => txCurrency(t) === 'USD').reduce((s, t) => s + parseFloat(t.amount), 0),
            pendingPayableARS: pendingPayableTx.filter(t => txCurrency(t) === 'ARS').reduce((s, t) => s + parseFloat(t.amount), 0),
            pendingPayableUSD: pendingPayableTx.filter(t => txCurrency(t) === 'USD').reduce((s, t) => s + parseFloat(t.amount), 0),
          },
        });
      }

      // Default: return all transactions sorted by date. Include the deduped
      // transfers so the consumer sees them once per pair without affecting
      // money totals.
      const responseTx = [
        ...(includeCancelled ? nonTransferTx : liveTx),
        ...dedupedTransfers,
      ];
      res.json({
        transactions: responseTx.sort((a, b) =>
          new Date(b.date).getTime() - new Date(a.date).getTime()
        ),
        summary: {
          totalTransactions: liveTx.length,
          cancelledTransactions: cancelledTx.length,
          transferTransactions: dedupedTransfers.length,
          orphanTransfers: orphanTransferEntries.length,
          orphanTransferIds,
          totalIncome: liveTx.filter(t => t.type === 'income').reduce((s, t) => s + parseFloat(t.amount), 0),
          totalExpense: liveTx.filter(t => t.type === 'expense').reduce((s, t) => s + parseFloat(t.amount), 0),
          totalReceivable: liveTx.filter(t => t.type === 'receivable').reduce((s, t) => s + parseFloat(t.amount), 0),
          totalPayable: liveTx.filter(t => t.type === 'payable').reduce((s, t) => s + parseFloat(t.amount), 0),
        },
      });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
}

// Exported for direct integration testing (mounted on a tiny Express app
// with auth/permissions stubbed). Production traffic always hits these via
// the routes registered in `registerTransactionRoutes` with the real
// middleware stack.
//
// Task #261: keep the reset of investment-account yield anchored to the
// adjust/force balance endpoints — when the underlying handler changes, the
// integration tests in tests/accountAdjustBalanceInterestReset.test.ts must
// fail loudly so users don't end up seeing wrong yields on Dashboard /
// Reports / valuation / weekly email again.
export async function adjustBalanceHandler(req: any, res: any) {
  try {
    const membership = await storage.getMembershipByUserAndOrg(req.userId, req.organizationId);
    if (!membership) {
      return res.status(403).json({ message: 'No tenés acceso a esta organización' });
    }
    const permissions = ROLE_PERMISSIONS[membership.role as Role] || [];
    if (!permissions.includes('accounts:edit')) {
      return res.status(403).json({ message: 'No tenés permiso para ajustar saldos' });
    }

    const { id } = req.params;
    const { newBalance, reason } = req.body;

    if (typeof newBalance !== 'string' || isNaN(parseFloat(newBalance))) {
      return res.status(400).json({ message: 'El nuevo saldo es requerido' });
    }

    const accounts = await storage.getAccountsByOrganization(req.organizationId);
    const account = accounts.find(a => a.id === id);
    if (!account) {
      return res.status(404).json({ message: 'Cuenta no encontrada' });
    }

    const currentBalance = parseFloat(account.balance);
    const targetBalance = parseFloat(newBalance);
    const difference = targetBalance - currentBalance;

    if (difference === 0) {
      return res.json({ account, message: 'No se requiere ajuste' });
    }

    const adjustmentType = difference > 0 ? 'income' : 'expense';
    const now = new Date();

    await storage.createTransaction({
      type: adjustmentType,
      amount: Math.abs(difference).toString(),
      description: `Ajuste de saldo${reason ? `: ${reason}` : ''}`,
      category: 'Ajuste Manual',
      date: now,
      imputationDate: now,
      accountId: id,
      organizationId: req.organizationId,
      createdBy: req.userId,
      status: 'completed',
      completedBy: req.userId,
      completedAt: now,
      hasInvoice: false,
      invoiceType: null,
      invoiceNumber: null,
      invoiceTaxId: null,
      invoiceFileUrl: null,
    });

    const updateData: any = { balance: newBalance };
    if (account.accountCategory === 'investment') {
      updateData.initialInvestment = newBalance;
      updateData.interestStartDate = now;
    }
    const updatedAccount = await storage.updateAccount(id, updateData);

    res.json({
      account: updatedAccount,
      adjustment: {
        type: adjustmentType,
        amount: Math.abs(difference),
        previousBalance: currentBalance,
        newBalance: targetBalance,
      }
    });
  } catch (error: any) {
    res.status(500).json({ message: sanitizeError(error) });
  }
}

export async function forceBalanceHandler(req: any, res: any) {
  try {
    const membership = await storage.getMembershipByUserAndOrg(req.userId, req.organizationId);
    if (!membership) {
      return res.status(403).json({ message: 'No tenés acceso a esta organización' });
    }
    const permissions = ROLE_PERMISSIONS[membership.role as Role] || [];
    if (!permissions.includes('accounts:edit')) {
      return res.status(403).json({ message: 'No tenés permiso para modificar saldos' });
    }

    const { id } = req.params;
    const { newBalance } = req.body;

    if (typeof newBalance !== 'string' || isNaN(parseFloat(newBalance))) {
      return res.status(400).json({ message: 'El nuevo saldo es requerido' });
    }

    const accounts = await storage.getAccountsByOrganization(req.organizationId);
    const account = accounts.find(a => a.id === id);
    if (!account) {
      return res.status(404).json({ message: 'Cuenta no encontrada' });
    }

    const previousBalance = parseFloat(account.balance);
    const targetBalance = parseFloat(newBalance);

    const updateData: any = { balance: newBalance };
    if (account.accountCategory === 'investment') {
      updateData.initialInvestment = newBalance;
      updateData.interestStartDate = new Date();
    }
    const updatedAccount = await storage.updateAccount(id, updateData);

    res.json({
      account: updatedAccount,
      previousBalance,
      newBalance: targetBalance,
      message: 'Saldo actualizado sin movimiento'
    });
  } catch (error: any) {
    res.status(500).json({ message: sanitizeError(error) });
  }
}

export async function repairTransferHandler(req: any, res: any) {
  try {
    const { id } = req.params;
    const tx = await storage.getTransaction(id);
    if (!tx) {
      return res.status(404).json({ message: 'Transacción no encontrada' });
    }
    if (tx.organizationId !== req.organizationId) {
      return res.status(403).json({ message: 'No tenés acceso a esta transacción' });
    }
    if (tx.type !== 'transfer_in' && tx.type !== 'transfer_out') {
      return res.status(400).json({ message: 'Solo se pueden reparar transferencias internas' });
    }
    if (tx.status === 'cancelled') {
      return res.status(400).json({ message: 'No se puede reparar una transferencia cancelada' });
    }

    // Confirm orphan status against current DB state — protects against
    // races where the counterpart was just created.
    const allOrgTx = await storage.getTransactionsByOrganization(req.organizationId);
    const existingCounterpart = tx.transferPairId
      ? allOrgTx.find(t =>
          t.id !== tx.id &&
          t.transferPairId === tx.transferPairId &&
          (t.type === 'transfer_in' || t.type === 'transfer_out') &&
          t.status !== 'cancelled',
        )
      : null;
    if (existingCounterpart) {
      return res.status(400).json({ message: 'Esta transferencia ya tiene su contraparte; no requiere reparación' });
    }

    const repairSchema = z.discriminatedUnion('action', [
      z.object({
        action: z.literal('recreate-pair'),
        counterpartAccountId: z.string().min(1, 'Cuenta contraparte requerida'),
        counterpartAmount: z.union([z.string(), z.number()]).optional(),
      }),
      z.object({
        action: z.literal('convert'),
        newType: z.enum(['income', 'expense']),
        category: z.string().min(1).optional(),
      }),
    ]);
    const parseResult = repairSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ message: 'Datos inválidos', errors: parseResult.error.errors });
    }
    const body = parseResult.data;

    if (body.action === 'recreate-pair') {
      if (body.counterpartAccountId === tx.accountId) {
        return res.status(400).json({ message: 'La cuenta contraparte debe ser distinta a la cuenta de la transferencia' });
      }
      const counterpartAccount = await storage.getAccount(body.counterpartAccountId);
      if (!counterpartAccount || counterpartAccount.organizationId !== req.organizationId) {
        return res.status(400).json({ message: 'Cuenta contraparte inválida' });
      }

      const originAccount = tx.accountId ? await storage.getAccount(tx.accountId) : null;
      const originAmount = parseFloat(tx.amount);
      let counterpartAmount = originAmount;
      if (body.counterpartAmount !== undefined && body.counterpartAmount !== null && body.counterpartAmount !== '') {
        let raw = String(body.counterpartAmount);
        // Accept "1.234,56" Argentine format as well as plain numbers
        if (raw.includes(',')) raw = raw.replace(/\./g, '').replace(',', '.');
        const parsed = parseFloat(raw);
        if (isNaN(parsed) || parsed <= 0) {
          return res.status(400).json({ message: 'Monto contraparte inválido' });
        }
        counterpartAmount = parsed;
      }

      // The orphan needs a `transferPairId` so the new leg can share it.
      const transferPairId = tx.transferPairId ?? crypto.randomUUID();
      const counterpartType = tx.type === 'transfer_out' ? 'transfer_in' : 'transfer_out';
      const isCounterpartCredit = counterpartType === 'transfer_in';

      const org = await storage.getOrganization(req.organizationId);
      const orgSuffix = (org?.name || 'XXXX').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4).padEnd(4, 'X');
      const counter = await storage.incrementTransactionCounter(req.organizationId);
      const counterpartTransactionNumber = `MOV-${String(counter).padStart(4, '0')}-${orgSuffix}`;

      const counterpartDescription = counterpartType === 'transfer_in'
        ? `Transferencia desde ${originAccount?.name ?? 'cuenta origen'} (reparada)`
        : `Transferencia a ${originAccount?.name ?? 'cuenta destino'} (reparada)`;
      const now = new Date();

      const txResult = await db.transaction(async (dbTx) => {
        // Concurrency guard: lock the orphan row and re-verify its state
        // inside the transaction. Two simultaneous repair requests on the
        // same orphan would otherwise both pass the pre-check and both
        // create a counterpart. SELECT ... FOR UPDATE serializes them so
        // the second attempt sees the freshly-set transferPairId or the
        // already-created counterpart and is rejected here.
        const lockedRows = await dbTx
          .select({ transferPairId: transactions.transferPairId })
          .from(transactions)
          .where(eq(transactions.id, tx.id))
          .for('update');
        const lockedPairId = lockedRows[0]?.transferPairId ?? null;
        if (lockedPairId) {
          // Was the counterpart created (or already there) since the
          // outer pre-check ran? If yes, abort instead of duplicating.
          const existing = await dbTx
            .select({ id: transactions.id })
            .from(transactions)
            .where(and(
              eq(transactions.transferPairId, lockedPairId),
              sql`${transactions.id} <> ${tx.id}`,
              inArray(transactions.type, ['transfer_in', 'transfer_out']),
              sql`${transactions.status} <> 'cancelled'`,
            ))
            .limit(1);
          if (existing.length > 0) {
            return { conflict: true as const };
          }
        }
        // Backfill `transferPairId` on the orphan if it was missing.
        if (!tx.transferPairId) {
          await dbTx.update(transactions)
            .set({ transferPairId })
            .where(eq(transactions.id, tx.id));
        }
        const [created] = await dbTx.insert(transactions).values({
          type: counterpartType,
          amount: String(counterpartAmount),
          currency: counterpartAccount.currency,
          description: counterpartDescription,
          category: tx.category || 'Transferencia Interna',
          imputationDate: tx.imputationDate ?? now,
          date: tx.date ?? now,
          accountId: counterpartAccount.id,
          organizationId: req.organizationId,
          hasInvoice: false,
          status: 'completed',
          completedBy: req.userId,
          completedAt: now,
          assetType: 'transfer',
          transferPairId,
          createdBy: req.userId,
          transactionNumber: counterpartTransactionNumber,
        }).returning();

        const balanceDelta = isCounterpartCredit ? counterpartAmount : -counterpartAmount;
        await dbTx.update(accounts)
          .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) + ${balanceDelta})` })
          .where(eq(accounts.id, counterpartAccount.id));

        return { conflict: false as const, newCounterpart: created };
      });

      if (txResult.conflict) {
        return res.status(409).json({
          message: 'Otra solicitud ya creó la contraparte de esta transferencia. Refrescá el detalle para verla.',
        });
      }
      const newCounterpart = txResult.newCounterpart;

      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'transaction',
        entityId: tx.id,
        action: 'repair_transfer',
        previousData: JSON.stringify({
          id: tx.id,
          transactionNumber: tx.transactionNumber,
          type: tx.type,
          amount: tx.amount,
          accountId: tx.accountId,
          transferPairId: tx.transferPairId,
          isOrphan: true,
          orphanReason: tx.transferPairId ? 'missing_counterpart' : 'no_pair_id',
        }),
        newData: JSON.stringify({
          mode: 'recreate-pair',
          transferPairId,
          createdCounterpart: {
            id: newCounterpart.id,
            transactionNumber: newCounterpart.transactionNumber,
            type: newCounterpart.type,
            accountId: newCounterpart.accountId,
            accountName: counterpartAccount.name,
            amount: newCounterpart.amount,
            currency: newCounterpart.currency,
          },
          backfilledTransferPairId: !tx.transferPairId,
        }),
      });

      return res.json({
        success: true,
        mode: 'recreate-pair',
        transferPairId,
        createdCounterpart: newCounterpart,
      });
    }

    // action === 'convert'
    // SIGN-PRESERVING ONLY. The original transfer leg already moved the
    // account balance: a `transfer_in` credited +X, a `transfer_out` debited
    // -X. Income preserves the credit, expense preserves the debit.
    // Allowing the opposite mapping (e.g. transfer_in -> expense) would
    // leave the account balance off by 2X, because we are NOT adjusting the
    // balance here on purpose. Reject the opposite mapping instead of
    // silently corrupting balances. The UI also constrains the choice, this
    // is the server-side guard.
    const expectedNewType = tx.type === 'transfer_in' ? 'income' : 'expense';
    if (body.newType !== expectedNewType) {
      return res.status(400).json({
        message: `Una ${tx.type === 'transfer_in' ? 'entrada' : 'salida'} de transferencia solo puede convertirse en ${expectedNewType === 'income' ? 'ingreso' : 'gasto'} (la cuenta ya ${tx.type === 'transfer_in' ? 'recibió' : 'perdió'} el monto al crearse la transferencia).`,
      });
    }
    const newType = body.newType;
    const fallbackCategory = newType === 'income' ? 'Ingresos varios' : 'Gastos varios';
    const newCategory = body.category && body.category.trim().length > 0
      ? body.category.trim()
      : fallbackCategory;
    const cleanedDescription = (tx.description || '').replace(/\s*\(reparada\)\s*$/i, '');
    const newDescription = `${cleanedDescription} [Convertida desde transferencia huérfana]`.trim();

    const updated = await storage.updateTransaction(tx.id, {
      type: newType,
      category: newCategory,
      description: newDescription,
      // Detach from the (broken) transfer pair so it stops being treated as
      // a transfer everywhere else.
      transferPairId: null,
      assetType: newType === 'expense' ? 'expense' : 'income',
      // Reset transfer-only metadata so reports count it like a regular
      // income/expense.
      expenseSubtype: newType === 'expense' ? 'expense' : null,
    });

    await storage.createAuditLog({
      organizationId: req.organizationId,
      userId: req.userId,
      entityType: 'transaction',
      entityId: tx.id,
      action: 'repair_transfer',
      previousData: JSON.stringify({
        id: tx.id,
        transactionNumber: tx.transactionNumber,
        type: tx.type,
        category: tx.category,
        description: tx.description,
        transferPairId: tx.transferPairId,
        assetType: tx.assetType,
        isOrphan: true,
        orphanReason: tx.transferPairId ? 'missing_counterpart' : 'no_pair_id',
      }),
      newData: JSON.stringify({
        mode: 'convert',
        newType,
        newCategory,
        newDescription,
        clearedTransferPairId: true,
      }),
    });

    return res.json({
      success: true,
      mode: 'convert',
      transaction: updated,
    });
  } catch (error: any) {
    console.error('Error repairing orphan transfer:', error);
    res.status(500).json({ message: sanitizeError(error) || 'Error al reparar la transferencia' });
  }
}
