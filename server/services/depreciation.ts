import { storage } from "../storage";
import type { Asset } from "@shared/schema";

export interface DepreciationResult {
  assetId: string;
  assetName: string;
  monthsDepreciated: number;
  depreciationAmount: number;
  newAccumulatedDepreciation: number;
  newBookValue: number;
}

export async function calculateMonthlyDepreciation(asset: Asset): Promise<DepreciationResult | null> {
  const acquisitionValue = parseFloat(asset.acquisitionValue.toString());
  const residualValue = parseFloat(asset.residualValue?.toString() || "0");
  const usefulLifeMonths = asset.usefulLifeMonths;
  const accumulatedDepreciation = parseFloat(asset.accumulatedDepreciation?.toString() || "0");
  
  const depreciableAmount = acquisitionValue - residualValue;
  const monthlyDepreciation = depreciableAmount / usefulLifeMonths;
  
  const now = new Date();
  const lastDepreciated = asset.lastDepreciatedAt ? new Date(asset.lastDepreciatedAt) : new Date(asset.acquisitionDate);
  
  const yearsDiff = now.getFullYear() - lastDepreciated.getFullYear();
  const monthsDiff = now.getMonth() - lastDepreciated.getMonth();
  const monthsToDepreciate = yearsDiff * 12 + monthsDiff;
  
  if (monthsToDepreciate <= 0) {
    return null;
  }
  
  const maxRemainingDepreciation = depreciableAmount - accumulatedDepreciation;
  if (maxRemainingDepreciation <= 0) {
    return null;
  }
  
  const depreciationAmount = Math.min(monthlyDepreciation * monthsToDepreciate, maxRemainingDepreciation);
  const newAccumulatedDepreciation = accumulatedDepreciation + depreciationAmount;
  const newBookValue = acquisitionValue - newAccumulatedDepreciation;
  
  return {
    assetId: asset.id,
    assetName: asset.name,
    monthsDepreciated: monthsToDepreciate,
    depreciationAmount,
    newAccumulatedDepreciation,
    newBookValue,
  };
}

export async function processDepreciationForOrganization(organizationId: string): Promise<DepreciationResult[]> {
  const results: DepreciationResult[] = [];
  
  const assetsList = await storage.getAssetsByOrganization(organizationId, true);
  
  for (const asset of assetsList) {
    const result = await calculateMonthlyDepreciation(asset);
    
    if (result) {
      await storage.updateAsset(asset.id, {
        accumulatedDepreciation: result.newAccumulatedDepreciation.toFixed(2),
        lastDepreciatedAt: new Date(),
      } as any);
      
      results.push(result);
    }
  }
  
  return results;
}

export function getDefaultUsefulLifeMonths(category: string): number {
  const USEFUL_LIFE_MAP: Record<string, number> = {
    real_estate: 240,
    vehicle: 60,
    machinery: 120,
    equipment: 60,
    technology: 36,
    furniture: 120,
    tools: 60,
    other: 60,
  };
  
  return USEFUL_LIFE_MAP[category] || 60;
}
