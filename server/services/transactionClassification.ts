import OpenAI from "../lib/claude";
import { ASSET_CATEGORIES, ASSET_USEFUL_LIFE, type AssetType, type AssetCategory } from "@shared/schema";
import { AI_MODELS } from "@shared/constants";

// Cliente Claude con interfaz compatible OpenAI (ver server/lib/claude.ts).
const openai = new OpenAI();

export interface ClassificationResult {
  assetType: AssetType;
  confidence: number; // 0.0 to 1.0
  assetCategory?: AssetCategory;
  suggestedUsefulLifeMonths?: number;
  reasoning: string;
  isCapitalExpenditure: boolean; // CapEx vs OpEx
}

export interface ClassificationInput {
  description: string;
  amount: number;
  category: string;
  type: 'income' | 'expense' | 'payable' | 'receivable';
  currency: string;
  organizationCountry?: string;
}

const CLASSIFICATION_PROMPT = `Eres un experto contador y analista financiero. Tu tarea es clasificar transacciones financieras en las siguientes categorías:

## TIPOS DE CLASIFICACIÓN (assetType):
1. **expense** - Gasto operativo: Costos del día a día que no generan activos duraderos
   - Ejemplos: alquiler, servicios (luz, gas, internet), sueldos, insumos de oficina, comida, transporte, marketing, suscripciones
   
2. **asset_acquisition** - Adquisición de activo: Compra de bienes duraderos que mantienen o aumentan valor
   - Ejemplos: inmuebles, vehículos, maquinaria, equipos, computadoras, mobiliario, patentes, licencias de software perpetuas
   
3. **investment** - Inversión financiera: Instrumentos financieros con expectativa de rendimiento
   - Ejemplos: acciones, bonos, fondos de inversión, criptomonedas, préstamos otorgados, depósitos a plazo
   
4. **income** - Ingreso: Dinero que entra a la empresa
   - Ejemplos: ventas, servicios prestados, alquileres cobrados, intereses ganados, dividendos

## CATEGORÍAS DE ACTIVOS (solo si assetType = "asset_acquisition"):
- real_estate: Inmuebles (departamentos, casas, terrenos, locales)
- vehicle: Vehículos (autos, camionetas, motos, camiones)
- machinery: Maquinaria industrial
- equipment: Equipos de trabajo
- furniture: Mobiliario (escritorios, sillas, estanterías)
- technology: Tecnología (computadoras, servidores, tablets, celulares)
- intangible: Intangibles (patentes, marcas, licencias perpetuas)
- other: Otros activos

## REGLAS CLAVE:
- Si es tipo "income" o "receivable", el assetType siempre es "income"
- Si es tipo "expense" o "payable" (cuenta por pagar), el assetType NUNCA puede ser "income". Debe ser "expense", "asset_acquisition" o "investment"
- Si el monto es muy bajo (< 10,000 en moneda local) y es un bien, probablemente es "expense" no activo
- Comprar propiedades SIEMPRE es "asset_acquisition" con categoría "real_estate"
- Pagar alquiler SIEMPRE es "expense" (no confundir con comprar)
- Comprar acciones o invertir en bolsa es "investment"
- Servicios mensuales (luz, gas, internet, streaming) son "expense"

Responde SOLO con un objeto JSON válido:
{
  "assetType": "expense" | "asset_acquisition" | "investment" | "income",
  "confidence": 0.0-1.0,
  "assetCategory": "categoría si es asset_acquisition o null",
  "suggestedUsefulLifeMonths": número o null,
  "reasoning": "explicación breve en español",
  "isCapitalExpenditure": true si es inversión de capital, false si es gasto operativo
}`;

export async function classifyTransaction(input: ClassificationInput): Promise<ClassificationResult> {
  try {
    // Quick classification for obvious cases
    if (input.type === 'income' || input.type === 'receivable') {
      return {
        assetType: 'income',
        confidence: 1.0,
        reasoning: 'Los ingresos y cuentas por cobrar se clasifican automáticamente como ingreso',
        isCapitalExpenditure: false,
      };
    }

    const userMessage = `Clasifica esta transacción:
- Descripción: "${input.description}"
- Monto: ${input.currency} ${input.amount.toLocaleString('es-AR')}
- Categoría actual: "${input.category}"
- Tipo: ${input.type === 'expense' ? 'Egreso' : input.type === 'payable' ? 'Cuenta por pagar' : input.type}
- País: ${input.organizationCountry || 'Argentina'}`;

    const completion = await openai.chat.completions.create({
      model: AI_MODELS.DEFAULT,
      messages: [
        { role: "system", content: CLASSIFICATION_PROMPT },
        { role: "user", content: userMessage },
      ],
      temperature: 0.1, // Low temperature for consistent classification
      max_tokens: 500,
    });

    const content = completion.choices[0]?.message?.content || '';
    
    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[Classification] No JSON found in response:', content);
      return getDefaultClassification(input);
    }

    const result = JSON.parse(jsonMatch[0]);
    
    // Validate and normalize response
    let assetType = validateAssetType(result.assetType) || getDefaultAssetType(input);
    
    if ((input.type === 'expense' || input.type === 'payable') && assetType === 'income') {
      console.warn(`[Classification] AI returned "income" for ${input.type} transaction "${input.description}" — correcting to "expense"`);
      assetType = 'expense';
    }
    const assetCategory = result.assetCategory as AssetCategory | undefined;
    
    return {
      assetType,
      confidence: Math.min(Math.max(parseFloat(result.confidence) || 0.5, 0), 1),
      assetCategory: assetType === 'asset_acquisition' ? assetCategory : undefined,
      suggestedUsefulLifeMonths: assetCategory ? ASSET_USEFUL_LIFE[assetCategory] : undefined,
      reasoning: result.reasoning || 'Clasificado por IA',
      isCapitalExpenditure: result.isCapitalExpenditure === true,
    };
  } catch (error) {
    console.error('[Classification] Error:', error);
    return getDefaultClassification(input);
  }
}

function validateAssetType(type: string): AssetType | null {
  const validTypes: AssetType[] = ['expense', 'asset_acquisition', 'investment', 'income'];
  return validTypes.includes(type as AssetType) ? (type as AssetType) : null;
}

function getDefaultAssetType(input: ClassificationInput): AssetType {
  if (input.type === 'income' || input.type === 'receivable') {
    return 'income';
  }
  return 'expense';
}

function getDefaultClassification(input: ClassificationInput): ClassificationResult {
  return {
    assetType: getDefaultAssetType(input),
    confidence: 0.5,
    reasoning: 'Clasificación por defecto (sin análisis IA)',
    isCapitalExpenditure: false,
  };
}

// Batch classification for multiple transactions
export async function classifyTransactions(inputs: ClassificationInput[]): Promise<ClassificationResult[]> {
  // Process in parallel with concurrency limit
  const results: ClassificationResult[] = [];
  const batchSize = 5;
  
  for (let i = 0; i < inputs.length; i += batchSize) {
    const batch = inputs.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(input => classifyTransaction(input)));
    results.push(...batchResults);
  }
  
  return results;
}
