import React, { useState, useRef, useMemo } from 'react';
import { useAccounts, useCreateTransaction, useOrganization, useClients, useSuppliers, useTransactions } from '@/lib/hooks';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Sparkles, ArrowRight, Loader2, Check, MessageCircle, Send, FileText, Upload, X, FileSpreadsheet, Download, CheckCircle2, TrendingUp, AlertTriangle, Lightbulb, Eye, RefreshCw, Pencil, Users, Building2, Link, ArrowLeftRight } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { cn, getArgentinaToday } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CategoryPicker, type CategoryPickerCategory } from '@/components/CategoryPicker';

// Fallback usado sólo si la organización no tiene categorías cargadas.
const FALLBACK_CATEGORIES = [
  'Ventas',
  'Combustible',
  'Servicios',
  'Suscripciones',
  'Viáticos',
  'Sueldos',
  'Impuestos',
  'Proveedores',
  'Alquiler',
  'Mantenimiento',
  'Otros'
];

export default function AIAssistantPage() {
  const { data: accounts = [] } = useAccounts();
  const { data: organization } = useOrganization();
  const { data: clients = [] } = useClients();
  const { data: suppliers = [] } = useSuppliers();
  const { data: allTransactions = [] } = useTransactions();
  const createTransactionMutation = useCreateTransaction();
  const queryClient = useQueryClient();
  const {
    data: orgCategories = [],
    isSuccess: orgCategoriesLoaded,
  } = useQuery<CategoryPickerCategory[]>({
    queryKey: ['/organization/categories'],
    queryFn: () => fetchWithAuth('/organization/categories'),
  });
  // Sólo caemos al listado genérico cuando la query terminó OK y la
  // organización efectivamente no tiene categorías cargadas. Mientras
  // carga o si falla, evitamos mostrar las categorías hardcodeadas.
  const useFallbackCategories = orgCategoriesLoaded && orgCategories.length === 0;
  const { toast } = useToast();
  const [input, setInput] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<any>(null);
  const [aiMessage, setAiMessage] = useState<string>('');
  
  // Bank statement analysis state
  const [bankStatementFile, setBankStatementFile] = useState<File | null>(null);
  const [bankStatementPreview, setBankStatementPreview] = useState<string | null>(null);
  const [isAnalyzingBankStatement, setIsAnalyzingBankStatement] = useState(false);
  const [bankStatementResult, setBankStatementResult] = useState<any>(null);
  const [selectedTransactions, setSelectedTransactions] = useState<Set<number>>(new Set());
  const [importingTransactions, setImportingTransactions] = useState(false);
  const bankStatementFileInputRef = useRef<HTMLInputElement>(null);
  const [importAccountId, setImportAccountId] = useState<string>('');
  const [isDraggingBankStatement, setIsDraggingBankStatement] = useState(false);
  const [editingTransactionIndex, setEditingTransactionIndex] = useState<number | null>(null);
  const [editingTransaction, setEditingTransaction] = useState<any>(null);
  
  // Pattern analysis state
  const [isAnalyzingPatterns, setIsAnalyzingPatterns] = useState(false);
  const [patternResult, setPatternResult] = useState<any>(null);

  const pendingStatuses = ['scheduled'];
  const pendingReceivables = useMemo(() =>
    allTransactions.filter((t: any) => t.type === 'receivable' && pendingStatuses.includes(t.status)),
    [allTransactions]
  );
  const pendingPayables = useMemo(() =>
    allTransactions.filter((t: any) => t.type === 'payable' && pendingStatuses.includes(t.status)),
    [allTransactions]
  );

  const updateAnalysisField = (field: string, value: any) => {
    setAnalysisResult((prev: any) => prev ? { ...prev, [field]: value } : null);
  };
  
  // Bank statement file handling
  const handleBankStatementFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowedTypes.includes(file.type)) {
      toast({
        title: "Formato no válido",
        description: "Solo se permiten imágenes (JPG, PNG, WebP) o PDF",
        variant: "destructive",
      });
      return;
    }
    
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "Archivo muy grande",
        description: "El archivo no puede superar 10MB",
        variant: "destructive",
      });
      return;
    }
    
    setBankStatementFile(file);
    setBankStatementResult(null);
    setSelectedTransactions(new Set());
    
    // Create preview for images
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setBankStatementPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    } else {
      setBankStatementPreview(null);
    }
  };

  const processDroppedFile = (file: File) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowedTypes.includes(file.type)) {
      toast({
        title: "Formato no válido",
        description: "Solo se permiten imágenes (JPG, PNG, WebP) o PDF",
        variant: "destructive",
      });
      return;
    }
    
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "Archivo muy grande",
        description: "El archivo no puede superar 10MB",
        variant: "destructive",
      });
      return;
    }
    
    setBankStatementFile(file);
    setBankStatementResult(null);
    setSelectedTransactions(new Set());
    
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setBankStatementPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    } else {
      setBankStatementPreview(null);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingBankStatement(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingBankStatement(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingBankStatement(false);
    
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      processDroppedFile(files[0]);
    }
  };
  
  const analyzeBankStatement = async () => {
    if (!bankStatementFile) return;
    
    setIsAnalyzingBankStatement(true);
    
    try {
      // Convert file to base64
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          const base64Data = result.split(',')[1];
          resolve(base64Data);
        };
        reader.onerror = reject;
        reader.readAsDataURL(bankStatementFile);
      });
      
      const result = await fetchWithAuth('/ai/analyze-bank-statement', {
        method: 'POST',
        body: JSON.stringify({
          imageBase64: base64,
          mimeType: bankStatementFile.type,
          accounts: accounts,
        }),
      });
      
      if (result.error) {
        toast({
          title: "Error de análisis",
          description: result.error,
          variant: "destructive",
        });
        return;
      }
      
      setBankStatementResult(result);
      // Select all transactions by default
      if (result.transactions && result.transactions.length > 0) {
        setSelectedTransactions(new Set(result.transactions.map((_: any, i: number) => i)));
      }
      
      toast({
        title: "Análisis completado",
        description: `Se encontraron ${result.transactions?.length || 0} movimientos`,
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo analizar el extracto bancario",
        variant: "destructive",
      });
    } finally {
      setIsAnalyzingBankStatement(false);
    }
  };
  
  const toggleTransaction = (index: number) => {
    const newSelected = new Set(selectedTransactions);
    if (newSelected.has(index)) {
      newSelected.delete(index);
    } else {
      newSelected.add(index);
    }
    setSelectedTransactions(newSelected);
  };
  
  const toggleAllTransactions = () => {
    if (!bankStatementResult?.transactions) return;
    if (selectedTransactions.size === bankStatementResult.transactions.length) {
      setSelectedTransactions(new Set());
    } else {
      setSelectedTransactions(new Set(bankStatementResult.transactions.map((_: any, i: number) => i)));
    }
  };

  const openEditTransaction = (index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const tx = bankStatementResult?.transactions[index];
    if (tx) {
      setEditingTransactionIndex(index);
      setEditingTransaction({ ...tx });
    }
  };

  const saveEditTransaction = () => {
    if (editingTransactionIndex === null || !editingTransaction || !bankStatementResult) return;
    if (editingTransaction.type === 'transfer') {
      if (!editingTransaction.toAccountId) {
        toast({ title: "Elegí una cuenta destino", description: "Las transferencias requieren una cuenta destino", variant: "destructive" });
        return;
      }
      if (editingTransaction.toAccountId === importAccountId) {
        toast({ title: "Cuenta destino inválida", description: "La cuenta destino no puede ser la misma que la cuenta de importación", variant: "destructive" });
        return;
      }
    }
    const newTransactions = [...bankStatementResult.transactions];
    newTransactions[editingTransactionIndex] = editingTransaction;
    const totalCredits = newTransactions
      .filter(tx => tx.type === 'income')
      .reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);
    const totalDebits = newTransactions
      .filter(tx => tx.type !== 'income')
      .reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);
    const balance = totalCredits - totalDebits;
    setBankStatementResult({
      ...bankStatementResult,
      transactions: newTransactions,
      summary: { ...bankStatementResult.summary, totalCredits, totalDebits, balance },
    });
    setEditingTransactionIndex(null);
    setEditingTransaction(null);
    toast({ title: "Movimiento actualizado" });
  };
  
  const importSelectedTransactions = async () => {
    if (!bankStatementResult?.transactions || selectedTransactions.size === 0) return;
    
    if (!importAccountId) {
      toast({
        title: "Seleccioná una cuenta",
        description: "Debés elegir una cuenta de destino antes de importar",
        variant: "destructive",
      });
      return;
    }
    
    setImportingTransactions(true);
    let successCount = 0;
    let errorCount = 0;
    
    try {
      for (const index of Array.from(selectedTransactions)) {
        const tx = bankStatementResult.transactions[index];
        try {
          if (tx.type === 'transfer') {
            if (!tx.toAccountId || tx.toAccountId === importAccountId) {
              errorCount++;
              console.error('Transfer missing or invalid destination account:', tx.description);
              continue;
            }
            await fetchWithAuth('/transactions/transfer', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                fromAccountId: importAccountId,
                toAccountId: tx.toAccountId,
                amount: tx.amount.toString(),
                description: tx.description || 'Transferencia importada',
              }),
            });
            successCount++;
          } else if (tx.linkedPendingId) {
            await fetchWithAuth(`/transactions/${tx.linkedPendingId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                status: 'completed',
                accountId: importAccountId,
              }),
            });
            successCount++;
          } else {
            await createTransactionMutation.mutateAsync({
              type: tx.type,
              amount: tx.amount.toString(),
              description: tx.description,
              // Si la org tiene categorías cargadas, respetamos la
              // categoría tal cual (que ya fue validada en backend o
              // editada por el usuario, y puede ser null). Sólo caemos
              // a 'Otros' cuando la org no tiene categorías y operamos
              // contra el listado genérico.
              category: tx.category || (useFallbackCategories ? 'Otros' : null),
              imputationDate: tx.date || getArgentinaToday(),
              date: tx.date || getArgentinaToday(),
              accountId: importAccountId,
              organizationId: organization?.id,
              hasInvoice: false,
              status: 'completed',
              ...(tx.clientId ? { clientId: tx.clientId } : {}),
              ...(tx.supplierId ? { supplierId: tx.supplierId } : {}),
            });
            successCount++;
          }
        } catch (err) {
          errorCount++;
          console.error('Failed to import transaction:', err);
        }
      }
      
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      
      toast({
        title: "Importación completada",
        description: `${successCount} movimientos importados${errorCount > 0 ? `, ${errorCount} con errores` : ''}`,
      });
      
      setBankStatementFile(null);
      setBankStatementPreview(null);
      setBankStatementResult(null);
      setSelectedTransactions(new Set());
      setImportAccountId('');
    } catch (error: any) {
      toast({
        title: "Error de importación",
        description: error.message || "No se pudieron importar los movimientos",
        variant: "destructive",
      });
    } finally {
      setImportingTransactions(false);
    }
  };
  
  const clearBankStatement = () => {
    setBankStatementFile(null);
    setBankStatementPreview(null);
    setBankStatementResult(null);
    setSelectedTransactions(new Set());
    if (bankStatementFileInputRef.current) {
      bankStatementFileInputRef.current.value = '';
    }
  };
  
  // Pattern analysis function
  const analyzePatterns = async () => {
    setIsAnalyzingPatterns(true);
    
    try {
      const result = await fetchWithAuth('/ai/analyze-transactions', {
        method: 'POST',
      });
      setPatternResult(result);
      
      toast({
        title: "Análisis completado",
        description: result.insights?.length > 0 ? `Se encontraron ${result.insights.length} insights` : "Análisis generado",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo analizar los patrones",
        variant: "destructive",
      });
    } finally {
      setIsAnalyzingPatterns(false);
    }
  };

  const handleAnalyze = async () => {
    if (!input.trim()) return;
    
    setIsAnalyzing(true);
    setAnalysisResult(null);
    setAiMessage('');

    try {
      const analysis = await fetchWithAuth('/ai/analyze', {
        method: 'POST',
        body: JSON.stringify({ 
          text: input,
          accounts: accounts 
        }),
      });
      
      // Always show the AI message
      setAiMessage(analysis.message || '');
      
      // Only show transaction form if it's a transaction
      if (analysis.isTransaction) {
        setAnalysisResult({
          type: analysis.type || 'expense',
          amount: analysis.amount || 0,
          description: analysis.description || input,
          category: analysis.category || 'Otros',
          accountSuggestion: analysis.accountSuggestion || 'Caja Chica',
          confidence: analysis.confidence || 0
        });
      } else {
        setAnalysisResult(null);
      }
      
      setInput('');
    } catch (error: any) {
      toast({
        title: "Error de IA",
        description: error.message || "No se pudo analizar el texto",
        variant: "destructive",
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleConfirm = async () => {
    if (!analysisResult) return;
    
    try {
      // Find account by ID or name
      const account = accounts.find((a: any) => a.id === analysisResult.accountId) || 
                      accounts.find((a: any) => a.name === analysisResult.accountSuggestion) || 
                      accounts[0];

      await createTransactionMutation.mutateAsync({
        type: analysisResult.type,
        amount: analysisResult.amount.toString(),
        description: analysisResult.description,
        category: analysisResult.category,
        accountId: account?.id || null,
        organizationId: organization?.id,
        date: getArgentinaToday(),
        imputationDate: getArgentinaToday(),
        hasInvoice: false,
        invoiceType: null,
        invoiceNumber: null,
        invoiceTaxId: null,
        status: 'completed',
      });

      toast({
        title: "Movimiento creado por IA",
        description: "Se ha registrado el movimiento correctamente.",
      });

      setInput('');
      setAnalysisResult(null);
      setAiMessage('');
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo crear el movimiento",
        variant: "destructive",
      });
    }
  };

  return (
    <>
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center p-3 bg-indigo-100 rounded-full mb-4">
            <Sparkles className="h-8 w-8 text-indigo-600" />
          </div>
          <h1 className="text-3xl font-bold font-display">Asistente Inteligente</h1>
          <p className="text-muted-foreground">Tu asistente financiero con inteligencia artificial</p>
        </div>

        <Tabs defaultValue="chat" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="chat" className="gap-2">
              <MessageCircle className="h-4 w-4" />
              <span className="hidden sm:inline">Chat</span>
              <span className="sm:hidden">Chat</span>
            </TabsTrigger>
            <TabsTrigger value="bank-statement" className="gap-2">
              <FileSpreadsheet className="h-4 w-4" />
              <span className="hidden sm:inline">Extracto</span>
              <span className="sm:hidden">Extracto</span>
            </TabsTrigger>
            <TabsTrigger value="patterns" className="gap-2">
              <TrendingUp className="h-4 w-4" />
              <span className="hidden sm:inline">Patrones</span>
              <span className="sm:hidden">Patrones</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="chat" className="space-y-6 mt-6">
            {/* AI Message Bubble */}
            {aiMessage && (
              <div className="flex items-start gap-3 animate-in fade-in slide-in-from-bottom-2">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
                  <Sparkles className="h-5 w-5 text-white" />
                </div>
                <div className="flex-1 bg-white rounded-2xl rounded-tl-sm p-4 shadow-md border border-gray-100">
                  <p className="text-gray-800 leading-relaxed">{aiMessage}</p>
                </div>
              </div>
            )}

            <Card className="border-indigo-100 shadow-lg shadow-indigo-500/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MessageCircle className="h-5 w-5" /> Chatea con Aike
                </CardTitle>
                <CardDescription>Contale lo que gastaste o cobraste, por ejemplo: "Pague Shell $25000"</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  <Textarea 
                    placeholder="Escribí acá..." 
                className="resize-none text-base p-3 min-h-[60px] flex-1"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleAnalyze();
                  }
                }}
              />
              <Button 
                className="h-auto bg-indigo-600 hover:bg-indigo-700 px-4"
                onClick={handleAnalyze}
                disabled={isAnalyzing || !input}
              >
                {isAnalyzing ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Send className="h-5 w-5" />
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {analysisResult && (
          <Card className="border-green-100 bg-green-50/50 animate-in fade-in slide-in-from-bottom-4">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-green-800 flex items-center gap-2">
                  <Check className="h-5 w-5" /> Análisis Completado
                </CardTitle>
                {analysisResult.confidence > 0 && (
                  <span className={`text-xs font-medium px-2 py-1 rounded-full ${
                    analysisResult.confidence >= 80 ? 'bg-green-100 text-green-700' :
                    analysisResult.confidence >= 50 ? 'bg-yellow-100 text-yellow-700' :
                    'bg-red-100 text-red-700'
                  }`}>
                    {analysisResult.confidence}% confianza
                  </span>
                )}
              </div>
              <CardDescription>Podés modificar los campos antes de confirmar</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-white p-3 rounded-md border border-green-100">
                  <span className="text-xs text-muted-foreground uppercase font-bold mb-2 block">Tipo</span>
                  <Select 
                    value={analysisResult.type} 
                    onValueChange={(value) => updateAnalysisField('type', value)}
                  >
                    <SelectTrigger className="w-full" data-testid="select-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="income">Ingreso</SelectItem>
                      <SelectItem value="expense">Egreso</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="bg-white p-3 rounded-md border border-green-100">
                  <span className="text-xs text-muted-foreground uppercase font-bold mb-2 block">Monto</span>
                  <Input 
                    type="number"
                    value={analysisResult.amount}
                    onChange={(e) => updateAnalysisField('amount', parseFloat(e.target.value) || 0)}
                    className="font-medium text-lg"
                    data-testid="input-amount"
                  />
                </div>
                <div className="bg-white p-3 rounded-md border border-green-100">
                  <span className="text-xs text-muted-foreground uppercase font-bold mb-2 block">Categoría</span>
                  <Select 
                    value={analysisResult.category} 
                    onValueChange={(value) => updateAnalysisField('category', value)}
                  >
                    <SelectTrigger className="w-full" data-testid="select-category">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FALLBACK_CATEGORIES.map((cat) => (
                        <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="bg-white p-3 rounded-md border border-green-100">
                  <span className="text-xs text-muted-foreground uppercase font-bold mb-2 block">Cuenta</span>
                  <Select 
                    value={analysisResult.accountId || ''} 
                    onValueChange={(value) => updateAnalysisField('accountId', value)}
                  >
                    <SelectTrigger className="w-full" data-testid="select-account">
                      <SelectValue placeholder={analysisResult.accountSuggestion || 'Seleccionar cuenta'} />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((account: any) => (
                        <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
            <CardFooter>
              <div className="flex gap-3 w-full">
                <Button variant="outline" className="flex-1" onClick={() => setAnalysisResult(null)}>Cancelar</Button>
                <Button className="flex-1 bg-green-600 hover:bg-green-700 text-white" onClick={handleConfirm}>
                  Confirmar y Guardar
                </Button>
              </div>
            </CardFooter>
          </Card>
        )}
          </TabsContent>

          <TabsContent value="bank-statement" className="space-y-6 mt-6">
            <Card className="border-primary/20 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileSpreadsheet className="h-5 w-5 text-primary" />
                  Analizá tu Extracto Bancario
                </CardTitle>
                <CardDescription>
                  Subí una imagen o PDF de tu extracto bancario y la IA extraerá automáticamente los movimientos
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <input
                  type="file"
                  ref={bankStatementFileInputRef}
                  onChange={handleBankStatementFileChange}
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  className="hidden"
                  data-testid="input-bank-statement-file"
                />
                
                {!bankStatementFile ? (
                  <div 
                    onClick={() => bankStatementFileInputRef.current?.click()}
                    onDragOver={handleDragOver}
                    onDragEnter={handleDragEnter}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={cn(
                      "border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all",
                      isDraggingBankStatement 
                        ? "border-primary bg-primary/10 scale-[1.02]" 
                        : "border-primary/30 hover:border-primary/60 hover:bg-primary/5"
                    )}
                    data-testid="button-upload-bank-statement"
                  >
                    <Upload className={cn(
                      "h-10 w-10 mx-auto mb-3 transition-colors",
                      isDraggingBankStatement ? "text-primary" : "text-primary/60"
                    )} />
                    <p className="font-medium mb-1">
                      {isDraggingBankStatement ? "Soltá el archivo aquí" : "Arrastrá o hacé clic para subir"}
                    </p>
                    <p className="text-sm text-muted-foreground">JPG, PNG, WebP o PDF (máx. 10MB)</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between p-4 bg-secondary/50 rounded-lg">
                      <div className="flex items-center gap-3">
                        <FileText className="h-8 w-8 text-primary" />
                        <div>
                          <p className="font-medium">{bankStatementFile.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {(bankStatementFile.size / 1024 / 1024).toFixed(2)} MB
                          </p>
                        </div>
                      </div>
                      <Button variant="ghost" size="icon" onClick={clearBankStatement}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    
                    {bankStatementPreview && (
                      <div className="rounded-lg overflow-hidden border max-h-64 overflow-y-auto">
                        <img src={bankStatementPreview} alt="Preview" className="w-full" />
                      </div>
                    )}
                    
                    {!bankStatementResult && (
                      <Button 
                        onClick={analyzeBankStatement}
                        disabled={isAnalyzingBankStatement}
                        className="w-full"
                        data-testid="button-analyze-statement"
                      >
                        {isAnalyzingBankStatement ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Analizando con IA...
                          </>
                        ) : (
                          <>
                            <Sparkles className="h-4 w-4 mr-2" />
                            Analizar Extracto
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {bankStatementResult && bankStatementResult.transactions && (
              <Card className="border-green-100 animate-in fade-in slide-in-from-bottom-4">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-green-800 flex items-center gap-2">
                      <CheckCircle2 className="h-5 w-5" />
                      Movimientos Detectados
                    </CardTitle>
                    <Badge variant="secondary" className="bg-green-100 text-green-700">
                      {bankStatementResult.transactions.length} movimientos
                    </Badge>
                  </div>
                  {bankStatementResult.bankName && (
                    <CardDescription>
                      {bankStatementResult.bankName}
                      {bankStatementResult.periodStart && bankStatementResult.periodEnd && (
                        <> • {bankStatementResult.periodStart} a {bankStatementResult.periodEnd}</>
                      )}
                    </CardDescription>
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-3 mb-3">
                    <div className="flex items-center gap-2">
                      <Label className="text-sm font-medium">Cuenta de destino:</Label>
                      <Select value={importAccountId} onValueChange={setImportAccountId}>
                        <SelectTrigger className="w-[200px]" data-testid="select-import-account">
                          <SelectValue placeholder="Seleccionar cuenta" />
                        </SelectTrigger>
                        <SelectContent>
                          {accounts.map((acc: any) => (
                            <SelectItem key={acc.id} value={acc.id}>
                              {acc.name} ({acc.currency})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={selectedTransactions.size === bankStatementResult.transactions.length}
                        onCheckedChange={toggleAllTransactions}
                        data-testid="checkbox-select-all"
                      />
                      <span className="text-muted-foreground text-sm">
                        {selectedTransactions.size} seleccionados
                      </span>
                    </div>
                  </div>
                  
                  <div className="max-h-80 overflow-y-auto space-y-2 pr-1">
                    {bankStatementResult.transactions.map((tx: any, index: number) => (
                      <div 
                        key={index}
                        className={cn(
                          "flex items-center gap-3 p-3 rounded-lg border transition-all cursor-pointer",
                          selectedTransactions.has(index) 
                            ? "bg-green-50 border-green-200" 
                            : "bg-white border-gray-200 hover:border-gray-300"
                        )}
                        onClick={() => toggleTransaction(index)}
                        data-testid={`transaction-row-${index}`}
                      >
                        <Checkbox
                          checked={selectedTransactions.has(index)}
                          onCheckedChange={() => toggleTransaction(index)}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium truncate">{tx.description}</span>
                            <span className={cn(
                              "font-bold whitespace-nowrap",
                              tx.type === 'income' ? "text-green-600" : "text-red-600"
                            )}>
                              {tx.type === 'income' ? '+' : '-'}AR$ {tx.amount?.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1 flex-wrap">
                            <span>{tx.date || 'Sin fecha'}</span>
                            <span>•</span>
                            {(() => {
                              if (tx.type === 'transfer') {
                                return <Badge variant="outline" className="text-xs">Transferencia</Badge>;
                              }
                              const catName = tx.category || 'Sin categoría';
                              const matchedCat = tx.category
                                ? orgCategories.find(
                                    (c) =>
                                      c.name.toLocaleLowerCase('es-AR') === String(tx.category).toLocaleLowerCase('es-AR') &&
                                      c.type === (tx.type === 'income' ? 'income' : 'expense')
                                  )
                                : undefined;
                              return (
                                <>
                                  <Badge variant="outline" className="text-xs">{catName}</Badge>
                                  {matchedCat && matchedCat.type === 'expense' && (
                                    <span
                                      className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                                        matchedCat.expenseSubtype === 'cost'
                                          ? 'bg-orange-500/20 text-orange-600 dark:text-orange-400'
                                          : 'bg-purple-500/20 text-purple-600 dark:text-purple-400'
                                      }`}
                                    >
                                      {matchedCat.expenseSubtype === 'cost' ? 'Costo' : 'Gasto'}
                                    </span>
                                  )}
                                </>
                              );
                            })()}
                            {tx.clientId && (
                              <Badge variant="outline" className="text-xs bg-cyan-50 text-cyan-700 border-cyan-200">
                                <Users className="h-3 w-3 mr-1" />
                                {clients.find((c: any) => c.id === tx.clientId)?.name || 'Cliente'}
                              </Badge>
                            )}
                            {tx.supplierId && (
                              <Badge variant="outline" className="text-xs bg-orange-50 text-orange-700 border-orange-200">
                                <Building2 className="h-3 w-3 mr-1" />
                                {suppliers.find((s: any) => s.id === tx.supplierId)?.name || 'Proveedor'}
                              </Badge>
                            )}
                            {tx.linkedPendingId && (
                              <Badge variant="outline" className="text-xs bg-purple-50 text-purple-700 border-purple-200">
                                <Link className="h-3 w-3 mr-1" />
                                Vinculado
                              </Badge>
                            )}
                            {tx.type === 'transfer' && tx.toAccountId && (
                              <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
                                <ArrowLeftRight className="h-3 w-3 mr-1" />
                                → {accounts.find((a: any) => a.id === tx.toAccountId)?.name || 'Cuenta'}
                              </Badge>
                            )}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 flex-shrink-0"
                          onClick={(e) => openEditTransaction(index, e)}
                          data-testid={`edit-transaction-${index}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  
                  {bankStatementResult.summary && (
                    <div className="grid grid-cols-3 gap-2 pt-3 border-t mt-3 text-center text-sm">
                      <div>
                        <p className="text-muted-foreground">Créditos</p>
                        <p className="font-bold text-green-600">
                          +AR$ {bankStatementResult.summary.totalCredits?.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Débitos</p>
                        <p className="font-bold text-red-600">
                          -AR$ {bankStatementResult.summary.totalDebits?.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Balance</p>
                        <p className="font-bold">
                          AR$ {bankStatementResult.summary.balance?.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                        </p>
                      </div>
                    </div>
                  )}
                </CardContent>
                <CardFooter className="flex gap-3">
                  <Button 
                    variant="outline" 
                    className="flex-1"
                    onClick={clearBankStatement}
                  >
                    Cancelar
                  </Button>
                  <Button 
                    className="flex-1 bg-green-600 hover:bg-green-700"
                    onClick={importSelectedTransactions}
                    disabled={selectedTransactions.size === 0 || importingTransactions}
                    data-testid="button-import-transactions"
                  >
                    {importingTransactions ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Importando...
                      </>
                    ) : (
                      <>
                        <Download className="h-4 w-4 mr-2" />
                        Importar {selectedTransactions.size} movimientos
                      </>
                    )}
                  </Button>
                </CardFooter>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="patterns" className="space-y-6 mt-6">
            <Card className="border-primary/20 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-primary" />
                  Análisis de Patrones
                </CardTitle>
                <CardDescription>
                  La IA analiza tus movimientos para detectar anomalías, gastos faltantes y oportunidades de ahorro
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!patternResult ? (
                  <div className="text-center py-8">
                    <Eye className="h-12 w-12 mx-auto mb-4 text-muted-foreground/50" />
                    <p className="text-muted-foreground mb-4">
                      Analizá tus movimientos para descubrir patrones ocultos
                    </p>
                    <Button 
                      onClick={analyzePatterns}
                      disabled={isAnalyzingPatterns}
                      size="lg"
                      data-testid="button-analyze-patterns"
                    >
                      {isAnalyzingPatterns ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Analizando...
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-4 w-4 mr-2" />
                          Analizar Patrones
                        </>
                      )}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {/* Summary */}
                    <div className="bg-gradient-to-br from-primary/10 to-secondary/30 rounded-xl p-4">
                      <p className="text-sm leading-relaxed">{patternResult.summary}</p>
                    </div>
                    
                    {/* Refresh button */}
                    <div className="flex justify-end">
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={analyzePatterns}
                        disabled={isAnalyzingPatterns}
                      >
                        {isAnalyzingPatterns ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4" />
                        )}
                        <span className="ml-2">Actualizar</span>
                      </Button>
                    </div>
                    
                    {/* Insights */}
                    {patternResult.insights && patternResult.insights.length > 0 && (
                      <div className="space-y-3">
                        <h3 className="font-semibold text-sm uppercase text-muted-foreground">Insights</h3>
                        {patternResult.insights.map((insight: any, index: number) => (
                          <div 
                            key={index}
                            className={cn(
                              "p-4 rounded-lg border-l-4",
                              insight.type === 'anomaly' && "bg-red-50 border-red-500",
                              insight.type === 'warning' && "bg-yellow-50 border-yellow-500",
                              insight.type === 'opportunity' && "bg-green-50 border-green-500",
                              insight.type === 'pattern' && "bg-blue-50 border-blue-500"
                            )}
                          >
                            <div className="flex items-start gap-3">
                              {insight.type === 'anomaly' && <AlertTriangle className="h-5 w-5 text-red-500 flex-shrink-0" />}
                              {insight.type === 'warning' && <AlertTriangle className="h-5 w-5 text-yellow-500 flex-shrink-0" />}
                              {insight.type === 'opportunity' && <Lightbulb className="h-5 w-5 text-green-500 flex-shrink-0" />}
                              {insight.type === 'pattern' && <TrendingUp className="h-5 w-5 text-blue-500 flex-shrink-0" />}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                  <h4 className="font-medium">{insight.title}</h4>
                                  <Badge 
                                    variant="outline" 
                                    className={cn(
                                      insight.priority === 'high' && "border-red-300 text-red-700",
                                      insight.priority === 'medium' && "border-yellow-300 text-yellow-700",
                                      insight.priority === 'low' && "border-gray-300 text-gray-600"
                                    )}
                                  >
                                    {insight.priority === 'high' ? 'Alta' : insight.priority === 'medium' ? 'Media' : 'Baja'}
                                  </Badge>
                                </div>
                                <p className="text-sm text-muted-foreground mt-1">{insight.description}</p>
                                {insight.actionable && (
                                  <p className="text-sm mt-2 font-medium text-primary">{insight.actionable}</p>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    
                    {/* Missing Recurring */}
                    {patternResult.missingRecurring && patternResult.missingRecurring.length > 0 && (
                      <div className="space-y-3">
                        <h3 className="font-semibold text-sm uppercase text-muted-foreground">Gastos Recurrentes Faltantes</h3>
                        <div className="grid gap-2">
                          {patternResult.missingRecurring.map((item: any, index: number) => (
                            <div key={index} className="p-3 bg-orange-50 rounded-lg border border-orange-200">
                              <div className="flex items-center justify-between">
                                <span className="font-medium">{item.name}</span>
                                <span className="text-sm text-orange-700">
                                  ~AR$ {item.estimatedAmount?.toLocaleString('es-AR')} / {item.frequency}
                                </span>
                              </div>
                              <p className="text-xs text-muted-foreground mt-1">{item.reason}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* Hidden Costs */}
                    {patternResult.hiddenCosts && patternResult.hiddenCosts.length > 0 && (
                      <div className="space-y-3">
                        <h3 className="font-semibold text-sm uppercase text-muted-foreground">Costos Ocultos Detectados</h3>
                        <div className="grid gap-2">
                          {patternResult.hiddenCosts.map((item: any, index: number) => (
                            <div key={index} className="p-3 bg-purple-50 rounded-lg border border-purple-200">
                              <div className="flex items-center justify-between">
                                <Badge variant="outline" className="border-purple-300">{item.category}</Badge>
                                <span className="text-sm text-purple-700 font-medium">
                                  Impacto: ~AR$ {item.estimatedImpact?.toLocaleString('es-AR')}
                                </span>
                              </div>
                              <p className="text-sm mt-2">{item.issue}</p>
                              <p className="text-xs text-purple-600 mt-1">{item.suggestion}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Edit Transaction Dialog */}
      <Dialog open={editingTransactionIndex !== null} onOpenChange={(open) => { if (!open) { setEditingTransactionIndex(null); setEditingTransaction(null); } }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar Movimiento</DialogTitle>
          </DialogHeader>
          {editingTransaction && (() => {
            const isTransfer = editingTransaction.type === 'transfer';
            const isIncome = editingTransaction.type === 'income';
            const isExpense = editingTransaction.type === 'expense';
            const selectedClientId = editingTransaction.clientId;
            const selectedSupplierId = editingTransaction.supplierId;
            const editAmount = Number(editingTransaction.amount) || 0;
            const matchingPending = (selectedClientId
              ? pendingReceivables.filter((t: any) => t.clientId === selectedClientId)
              : selectedSupplierId
                ? pendingPayables.filter((t: any) => t.supplierId === selectedSupplierId)
                : []
            ).sort((a: any, b: any) => Math.abs(parseFloat(a.amount) - editAmount) - Math.abs(parseFloat(b.amount) - editAmount));
            return (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Descripción</Label>
                <Input
                  value={editingTransaction.description || ''}
                  onChange={(e) => setEditingTransaction({ ...editingTransaction, description: e.target.value })}
                  data-testid="input-edit-description"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Monto</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={editingTransaction.amount || ''}
                    onChange={(e) => setEditingTransaction({ ...editingTransaction, amount: parseFloat(e.target.value) || 0 })}
                    data-testid="input-edit-amount"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Tipo</Label>
                  <Select
                    value={editingTransaction.type || 'expense'}
                    onValueChange={(value) => {
                      const updates: any = { ...editingTransaction, type: value };
                      if (value === 'transfer') {
                        updates.clientId = null;
                        updates.supplierId = null;
                        updates.linkedPendingId = null;
                      } else {
                        updates.toAccountId = null;
                        if (value === 'income') {
                          updates.supplierId = null;
                          updates.linkedPendingId = null;
                        } else if (value === 'expense') {
                          updates.clientId = null;
                          updates.linkedPendingId = null;
                        }
                      }
                      setEditingTransaction(updates);
                    }}
                  >
                    <SelectTrigger data-testid="select-edit-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="income">Ingreso</SelectItem>
                      <SelectItem value="expense">Egreso</SelectItem>
                      <SelectItem value="transfer">Transferencia</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Fecha</Label>
                  <Input
                    type="date"
                    value={editingTransaction.date?.split('T')[0] || ''}
                    onChange={(e) => setEditingTransaction({ ...editingTransaction, date: e.target.value })}
                    data-testid="input-edit-date"
                  />
                </div>
                {!isTransfer && (
                  <div className="space-y-2">
                    <Label>Categoría</Label>
                    {!useFallbackCategories ? (
                      <CategoryPicker
                        value={editingTransaction.category || ''}
                        onChange={(value) => setEditingTransaction({ ...editingTransaction, category: value })}
                        type={isIncome ? 'income' : 'expense'}
                        categories={orgCategories}
                        placeholder="Sin categoría"
                        testId="select-edit-category"
                        allowInlineCreate={false}
                      />
                    ) : (
                      <Select
                        value={editingTransaction.category || 'Otros'}
                        onValueChange={(value) => setEditingTransaction({ ...editingTransaction, category: value })}
                      >
                        <SelectTrigger data-testid="select-edit-category">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {FALLBACK_CATEGORIES.map((cat) => (
                            <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                )}
              </div>

              {isTransfer ? (
                <div className="space-y-2 p-3 rounded-lg bg-blue-50 border border-blue-200">
                  <Label className="flex items-center gap-2 text-blue-800">
                    <ArrowLeftRight className="h-4 w-4" />
                    Cuenta destino
                  </Label>
                  <Select
                    value={editingTransaction.toAccountId || ''}
                    onValueChange={(value) => setEditingTransaction({ ...editingTransaction, toAccountId: value })}
                  >
                    <SelectTrigger data-testid="select-edit-to-account">
                      <SelectValue placeholder="Elegir cuenta destino" />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts
                        .filter((a: any) => a.id !== importAccountId)
                        .map((acc: any) => (
                          <SelectItem key={acc.id} value={acc.id}>
                            {acc.name} ({acc.currency})
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-blue-600">El monto se debita de la cuenta de importación y se acredita en la cuenta destino.</p>
                </div>
              ) : (
                <>
                  <div className={cn("grid gap-4", (!isIncome && !isExpense) ? "grid-cols-2" : "grid-cols-1")}>
                    {(isIncome || (!isIncome && !isExpense)) && (
                      <div className="space-y-2">
                        <Label className="flex items-center gap-1.5">
                          <Users className="h-3.5 w-3.5 text-cyan-600" />
                          Cliente
                        </Label>
                        <Select
                          value={editingTransaction.clientId || '_none_'}
                          onValueChange={(value) => {
                            const cid = value === '_none_' ? null : value;
                            setEditingTransaction({
                              ...editingTransaction,
                              clientId: cid,
                              supplierId: cid ? null : editingTransaction.supplierId,
                              linkedPendingId: null,
                            });
                          }}
                        >
                          <SelectTrigger data-testid="select-edit-client">
                            <SelectValue placeholder="Sin cliente" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="_none_">Sin cliente</SelectItem>
                            {clients.map((c: any) => (
                              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {(isExpense || (!isIncome && !isExpense)) && (
                      <div className="space-y-2">
                        <Label className="flex items-center gap-1.5">
                          <Building2 className="h-3.5 w-3.5 text-orange-600" />
                          Proveedor
                        </Label>
                        <Select
                          value={editingTransaction.supplierId || '_none_'}
                          onValueChange={(value) => {
                            const sid = value === '_none_' ? null : value;
                            setEditingTransaction({
                              ...editingTransaction,
                              supplierId: sid,
                              clientId: sid ? null : editingTransaction.clientId,
                              linkedPendingId: null,
                            });
                          }}
                        >
                          <SelectTrigger data-testid="select-edit-supplier">
                            <SelectValue placeholder="Sin proveedor" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="_none_">Sin proveedor</SelectItem>
                            {suppliers.map((s: any) => (
                              <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>

                  {matchingPending.length > 0 && (
                    <div className="space-y-2 p-3 rounded-lg bg-purple-50 border border-purple-200">
                      <Label className="flex items-center gap-2 text-purple-800">
                        <Link className="h-4 w-4" />
                        Vincular a pendiente
                      </Label>
                      <Select
                        value={editingTransaction.linkedPendingId || '_none_'}
                        onValueChange={(value) => setEditingTransaction({
                          ...editingTransaction,
                          linkedPendingId: value === '_none_' ? null : value,
                        })}
                      >
                        <SelectTrigger data-testid="select-edit-linked-pending">
                          <SelectValue placeholder="No vincular" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="_none_">No vincular</SelectItem>
                          {matchingPending.map((p: any) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.description} — ${parseFloat(p.amount).toLocaleString('es-AR')} ({new Date(p.date).toLocaleDateString('es-AR')})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-purple-600">Al vincular, se marca el pendiente como cobrado/pagado en vez de crear un movimiento nuevo.</p>
                    </div>
                  )}
                </>
              )}
            </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEditingTransactionIndex(null); setEditingTransaction(null); }}>
              Cancelar
            </Button>
            <Button onClick={saveEditTransaction} data-testid="button-save-edit">
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
