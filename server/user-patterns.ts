import { storage } from "./storage";

export interface PatternSuggestion {
  accountId?: string;
  accountName?: string;
  category?: string;
  hasInvoice?: boolean;
  confidence: {
    account: number;
    category: number;
    hasInvoice: number;
  };
  source: {
    account?: 'pattern' | 'preference';
    category?: 'pattern' | 'preference';
    hasInvoice?: 'pattern' | 'preference';
  };
}

interface CacheEntry {
  data: PatternSuggestion;
  timestamp: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const CONFIDENCE_THRESHOLD = 0.70;
const ACCOUNT_CONFIDENCE_THRESHOLD = 0.45;
const INVOICE_CONFIDENCE_THRESHOLD = 0.90;

const patternCache = new Map<string, CacheEntry>();

function getCacheKey(userId: string, organizationId: string, type: string, description?: string): string {
  return `${userId}:${organizationId}:${type}:${description || ''}`;
}

function normalizeWords(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-záéíóúñü\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

function wordSimilarity(words1: string[], words2: string[]): number {
  if (words1.length === 0 || words2.length === 0) return 0;
  const set1 = new Set(words1);
  const set2 = new Set(words2);
  let matches = 0;
  for (const w of set1) {
    if (set2.has(w)) matches++;
  }
  return matches / Math.max(set1.size, set2.size);
}

export async function analyzeUserPatterns(
  userId: string,
  organizationId: string,
  transactionType: string,
  description?: string
): Promise<PatternSuggestion> {
  const cacheKey = getCacheKey(userId, organizationId, transactionType, description);
  const cached = patternCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const result: PatternSuggestion = {
    confidence: { account: 0, category: 0, hasInvoice: 0 },
    source: {},
  };

  try {
    const prefs = await storage.getWhatsappPreferences(userId, organizationId);

    if (prefs?.preferredAccountId) {
      const accounts = await storage.getAccountsByOrganization(organizationId);
      const prefAccount = accounts.find(a => a.id === prefs.preferredAccountId);
      if (prefAccount) {
        result.accountId = prefAccount.id;
        result.accountName = prefAccount.name;
        result.confidence.account = 1.0;
        result.source.account = 'preference';
      }
    }

    const prefCategory = transactionType === 'income' || transactionType === 'receivable'
      ? prefs?.preferredIncomeCategory
      : prefs?.preferredExpenseCategory;
    if (prefCategory) {
      result.category = prefCategory;
      result.confidence.category = 1.0;
      result.source.category = 'preference';
    }

    if (prefs?.defaultHasInvoice !== null && prefs?.defaultHasInvoice !== undefined) {
      result.hasInvoice = prefs.defaultHasInvoice;
      result.confidence.hasInvoice = 1.0;
      result.source.hasInvoice = 'preference';
    }

    const allTransactions = await storage.getTransactionsByOrganization(
      organizationId, 'completed', { limit: 1000 }
    );

    const userTransactions = allTransactions.filter(t => t.createdBy === userId).slice(0, 100);
    const typeTransactions = userTransactions.filter(t => t.type === transactionType);

    if (result.confidence.account < ACCOUNT_CONFIDENCE_THRESHOLD && typeTransactions.length >= 3) {
      const accountCounts = new Map<string, { count: number; name: string }>();
      for (const t of typeTransactions) {
        if (t.accountId) {
          const entry = accountCounts.get(t.accountId) || { count: 0, name: '' };
          entry.count++;
          if (!entry.name && t.accountId) {
            const accounts = await storage.getAccountsByOrganization(organizationId);
            const acc = accounts.find(a => a.id === t.accountId);
            entry.name = acc?.name || '';
          }
          accountCounts.set(t.accountId, entry);
        }
      }

      if (accountCounts.size > 0) {
        const total = typeTransactions.filter(t => t.accountId).length;
        let topAccountId = '';
        let topCount = 0;
        let topName = '';
        for (const [id, { count: c, name }] of accountCounts) {
          if (c > topCount) {
            topCount = c;
            topAccountId = id;
            topName = name;
          }
        }
        const confidence = total > 0 ? topCount / total : 0;
        if (confidence >= ACCOUNT_CONFIDENCE_THRESHOLD) {
          result.accountId = topAccountId;
          result.accountName = topName;
          result.confidence.account = confidence;
          result.source.account = 'pattern';
        }
      }
    }

    if (result.confidence.category < CONFIDENCE_THRESHOLD && description && typeTransactions.length >= 3) {
      const descWords = normalizeWords(description);
      if (descWords.length > 0) {
        const similarTransactions = typeTransactions.filter(t => {
          if (!t.description) return false;
          const tWords = normalizeWords(t.description);
          return wordSimilarity(descWords, tWords) >= 0.4;
        });

        if (similarTransactions.length >= 2) {
          const categoryCounts = new Map<string, number>();
          for (const t of similarTransactions) {
            if (t.category && t.category !== 'General') {
              categoryCounts.set(t.category, (categoryCounts.get(t.category) || 0) + 1);
            }
          }

          if (categoryCounts.size > 0) {
            let topCategory = '';
            let topCount = 0;
            for (const [cat, c] of categoryCounts) {
              if (c > topCount) {
                topCount = c;
                topCategory = cat;
              }
            }
            const confidence = topCount / similarTransactions.length;
            if (confidence >= CONFIDENCE_THRESHOLD) {
              result.category = topCategory;
              result.confidence.category = confidence;
              result.source.category = 'pattern';
            }
          }
        }
      }
    }

    if (result.confidence.hasInvoice < INVOICE_CONFIDENCE_THRESHOLD && typeTransactions.length >= 5) {
      const withInvoice = typeTransactions.filter(t => t.hasInvoice).length;
      const withoutInvoice = typeTransactions.length - withInvoice;
      const total = typeTransactions.length;

      if (withoutInvoice / total >= INVOICE_CONFIDENCE_THRESHOLD) {
        result.hasInvoice = false;
        result.confidence.hasInvoice = withoutInvoice / total;
        result.source.hasInvoice = 'pattern';
      } else if (withInvoice / total >= INVOICE_CONFIDENCE_THRESHOLD) {
        result.hasInvoice = true;
        result.confidence.hasInvoice = withInvoice / total;
        result.source.hasInvoice = 'pattern';
      }
    }
  } catch (error) {
    console.error('[UserPatterns] Error analyzing patterns:', error);
  }

  patternCache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}

export function clearPatternCache(userId?: string, organizationId?: string): void {
  if (!userId) {
    patternCache.clear();
    return;
  }
  const prefix = organizationId ? `${userId}:${organizationId}:` : `${userId}:`;
  for (const key of patternCache.keys()) {
    if (key.startsWith(prefix)) {
      patternCache.delete(key);
    }
  }
}
