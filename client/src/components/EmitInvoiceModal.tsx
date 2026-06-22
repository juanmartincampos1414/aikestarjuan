import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Loader2, Receipt, AlertCircle, AlertTriangle, ChevronsUpDown, Check, User, HelpCircle, Plus, Trash2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchWithAuth } from "@/lib/api";
import { MONOTRIBUTO_MAX_UNIT_PRICE } from "@shared/constants";

type IvaCondition = "responsable_inscripto" | "monotributo" | "exento" | "consumidor_final";

interface DraftItem {
  id: string;
  description: string;
  quantity: string;
  unitNet: string;
  aliquot: number;
}

let draftItemSeq = 0;
const newDraftItemId = () => `item-${draftItemSeq++}`;

const IVA_OPTIONS: { value: IvaCondition; label: string }[] = [
  { value: "responsable_inscripto", label: "Responsable Inscripto" },
  { value: "monotributo", label: "Monotributo" },
  { value: "exento", label: "Exento" },
  { value: "consumidor_final", label: "Consumidor Final" },
];

const ALIQUOT_OPTIONS = [0, 2.5, 5, 10.5, 21, 27];

interface EmitInvoiceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction: any;
  onEmitted?: () => void;
}

export function EmitInvoiceModal({ open, onOpenChange, transaction, onEmitted }: EmitInvoiceModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Detect when emission will run in internal sandbox-mock mode so we can
  // warn the user that the resulting invoice will not have fiscal validity.
  const { data: invoicingAccount } = useQuery<any>({
    queryKey: ['/api/invoicing/account'],
    queryFn: async () => fetchWithAuth('/invoicing/account'),
    enabled: open,
  });
  const willBeSimulated = !!invoicingAccount?.sandboxMockActive
    && invoicingAccount?.account?.environment === 'sandbox';

  // Active selling points the user can pick from. We only surface the
  // selector when there is more than one — Tomás's UX guidance: "si tiene 1
  // solo punto de venta ni preguntar". When there's exactly one we still
  // send it explicitly so a stale acc.defaultSellingPoint (e.g. =1 from
  // signup, but ARCA only has =4) cannot break the emission.
  const sellingPoints: { number: number; description: string | null; isActive: boolean }[] =
    invoicingAccount?.sellingPoints || [];
  const activeSellingPoints = sellingPoints.filter((sp) => sp.isActive);
  const defaultSellingPoint: number | null =
    invoicingAccount?.account?.defaultSellingPoint ?? null;

  // Receiver
  const [receiverName, setReceiverName] = useState("");
  const [receiverTaxId, setReceiverTaxId] = useState("");
  const [receiverIva, setReceiverIva] = useState<IvaCondition>("consumidor_final");
  const [receiverEmail, setReceiverEmail] = useState("");
  const [sellingPoint, setSellingPoint] = useState<number | null>(null);

  // Client selector. `selectedClientId` is the org client whose data is
  // currently loaded into the receiver fields, or `"manual"` when the user
  // explicitly chose to type the receiver by hand. When `null` the modal is
  // showing the precarga from `transaction.client` (which may itself come
  // from a saved client). The combobox lists active clients for the org.
  const [selectedClientId, setSelectedClientId] = useState<string | "manual" | null>(null);
  const [clientPickerOpen, setClientPickerOpen] = useState(false);
  // Tracks whether the user has manually edited any receiver field this open.
  // Reset on every open. Used by the orgClients pre-populate effect to never
  // clobber user input — including IVA selector changes, which the empty-
  // string guards on the other fields cannot detect.
  const receiverTouchedRef = useRef(false);

  const { data: orgClients = [] } = useQuery<any[]>({
    queryKey: ['/api/clients', 'activeOnly'],
    queryFn: async () => fetchWithAuth('/clients?activeOnly=true'),
    enabled: open,
  });

  // Task #475: cuando la factura se abre desde la lista (la fila no trae los
  // renglones de productos), buscamos el detalle para precargar un ítem por
  // producto. Si la transacción ya viene con `items` (apertura desde el
  // detalle), no hace falta.
  const txId: string | undefined = (transaction as any)?.id;
  // El endpoint de lista adjunta items[] "livianos" (sin nombre de producto),
  // mientras que el detalle trae items "ricos" (con product.name/description).
  // Para precargar descripciones correctas en la factura necesitamos los ricos.
  const passedItems = (transaction as any)?.items;
  const txHasRichItems =
    Array.isArray(passedItems) &&
    passedItems.length > 0 &&
    passedItems.every((it: any) => it?.product || it?.description);
  const { data: txDetail } = useQuery<any>({
    queryKey: ['transaction-emit-detail', txId],
    queryFn: async () => fetchWithAuth(`/transactions/${txId}`),
    enabled: open && !!txId && !txHasRichItems,
  });

  // Line items. Default is a single line derived from the movement, but the
  // user can add more — needed for monotributo emitters whose per-item
  // unit_price ARCA caps (see MONOTRIBUTO_MAX_UNIT_PRICE).
  const [items, setItems] = useState<DraftItem[]>([]);
  const [observations, setObservations] = useState("");

  // Concepto del comprobante (ARCA). Por defecto "producto" para preservar el
  // comportamiento histórico. Cuando es servicio o ambos, ARCA exige el período
  // del servicio y el vencimiento de pago.
  type ItemType = "product" | "service" | "product_and_service";
  const [itemType, setItemType] = useState<ItemType>("product");
  const [serviceFrom, setServiceFrom] = useState("");
  const [serviceTo, setServiceTo] = useState("");
  const [paymentDueDate, setPaymentDueDate] = useState("");
  const includesService = itemType === "service" || itemType === "product_and_service";

  // Emitter IVA condition determines the comprobante class. Monotributo /
  // Exento always emit Factura C (no IVA discriminado), so default aliquot
  // must be 0 and the loaded amount represents the FINAL total — never
  // divide by 1.21 for these emitters (was causing 5000 → 4132.23).
  const emitterIvaCondition: string | undefined =
    invoicingAccount?.account?.ivaCondition;
  const emitterDiscriminatesIva = emitterIvaCondition === "responsable_inscripto";

  useEffect(() => {
    if (!open || !transaction) return;
    const client = transaction.client || {};
    const fallbackIva: IvaCondition =
      (client.ivaCondition as IvaCondition) ||
      (client.cuit ? "responsable_inscripto" : "consumidor_final");

    setReceiverName(client.name || "");
    setReceiverTaxId(client.cuit || "");
    setReceiverIva(fallbackIva);
    setReceiverEmail(client.email || "");
    setSelectedClientId((transaction as any)?.clientId || client.id || null);
    receiverTouchedRef.current = false;

    const txAny = transaction as any;
    const net = txAny.invoiceNetAmount
      ? Number(txAny.invoiceNetAmount)
      : Number(transaction.amount || 0);
    // For Factura C emitters (monotributo/exento) the only valid aliquot is
    // 0%. Force it regardless of whatever was previously stored on the tx
    // (legacy txs may carry 21 from the wizard's old default).
    const defaultAliquot = emitterDiscriminatesIva ? 21 : 0;
    const al = txAny.invoiceIvaAliquot != null ? Number(txAny.invoiceIvaAliquot) : defaultAliquot;
    const safeAl = Number.isFinite(al) ? al : defaultAliquot;
    // Task #475: cuando la transacción tiene varios renglones de productos,
    // precargar la factura con un renglón por producto (1 ítem ARCA = 1 producto).
    // Preferir items "ricos" (con product.name) sobre los livianos de la lista.
    const lineItems = txHasRichItems
      ? passedItems
      : (Array.isArray(txDetail?.items)
          ? txDetail.items
          : (Array.isArray(txAny.items) ? txAny.items : []));
    if (lineItems.length > 0) {
      setItems(
        lineItems.map((li: any) => {
          // Task #502: precargar la alícuota del producto cuando existe. Para
          // emisores que no discriminan IVA (Monotributo/Exento, Factura C) la
          // única alícuota válida sigue siendo 0%.
          const productAl = li.product?.ivaAliquot != null ? Number(li.product.ivaAliquot) : null;
          const itemAl = productAl != null && Number.isFinite(productAl) ? productAl : safeAl;
          return {
            id: newDraftItemId(),
            description: li.product?.name || li.description || "Producto",
            quantity: li.quantity != null ? String(li.quantity) : "1",
            unitNet: li.unitPrice != null ? String(li.unitPrice) : "",
            aliquot: emitterDiscriminatesIva ? itemAl : 0,
          };
        }),
      );
    } else {
      // Task #502: venta/compra de UN solo producto (sin renglones). Precargar
      // la alícuota del producto cuando exista. Precedencia: alícuota guardada
      // en la factura (override manual) > IVA del producto > default del emisor.
      const singleProductAl = txDetail?.product?.ivaAliquot != null
        ? Number(txDetail.product.ivaAliquot)
        : null;
      const singleAl = txAny.invoiceIvaAliquot == null
        && singleProductAl != null
        && Number.isFinite(singleProductAl)
          ? singleProductAl
          : safeAl;
      setItems([{
        id: newDraftItemId(),
        description: transaction.description || "Servicio",
        quantity: "1",
        unitNet: net ? net.toString() : "",
        aliquot: emitterDiscriminatesIva ? singleAl : 0,
      }]);
    }
    setObservations("");
    setItemType("product");
    setServiceFrom("");
    setServiceTo("");
    setPaymentDueDate("");
    setErrorMsg(null);
    setSellingPoint(null); // re-derived by the next effect from invoicing data
    // Include emitterIvaCondition in deps so we re-seed the aliquot once the
    // /api/invoicing/account query resolves. Otherwise an RI emitter could
    // momentarily get the monotributo default (0%) if the modal opens before
    // the account fetch completes.
  }, [open, transaction, emitterIvaCondition, txDetail]);

  // Pre-populate receiver fields from `orgClients` when the modal opened with
  // a `transaction.clientId` but no expanded `transaction.client` (the common
  // case in production, since the list endpoint doesn't join the client
  // object). Without this, the combobox would render the client correctly
  // but the four receiver inputs below it would stay empty — forcing the
  // user to re-open the desplegable and pick the same client. We only fire
  // when the receiver fields are still empty, so a user edit is never
  // clobbered when `orgClients` resolves a moment later.
  useEffect(() => {
    if (!open) return;
    if (!selectedClientId || selectedClientId === "manual") return;
    // Guard: never clobber a user edit. `receiverTouchedRef` is flipped to
    // true the first time the user interacts with ANY receiver field —
    // including the IVA selector, which the empty-string checks alone can't
    // detect. The empty-string checks remain as a defensive fallback in case
    // a future refactor forgets to wire an input through markReceiverTouched.
    if (receiverTouchedRef.current) return;
    if (receiverName || receiverTaxId || receiverEmail) return;
    if (!Array.isArray(orgClients) || orgClients.length === 0) return;
    const match = orgClients.find((c: any) => String(c.id) === String(selectedClientId));
    if (!match) return;
    const iva: IvaCondition =
      (match.ivaCondition as IvaCondition) ||
      (match.taxId && /^\d{11}$/.test(String(match.taxId))
        ? "responsable_inscripto"
        : "consumidor_final");
    setReceiverName(match.name || "");
    setReceiverTaxId(match.taxId || match.cuit || "");
    setReceiverIva(iva);
    setReceiverEmail(match.email || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedClientId, orgClients]);

  // Initialize / re-sync the selected selling point when invoicing data
  // arrives (the account query is enabled only while open). Prefer the saved
  // default if it's actually active, otherwise the first active one. Falls
  // back to null so the backend uses its own resolution if nothing synced.
  useEffect(() => {
    if (!open) return;
    if (sellingPoint != null) return; // user already picked one this session
    if (defaultSellingPoint != null
        && activeSellingPoints.some((sp) => sp.number === defaultSellingPoint)) {
      setSellingPoint(defaultSellingPoint);
    } else if (activeSellingPoints.length > 0) {
      setSellingPoint(activeSellingPoints[0].number);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultSellingPoint, activeSellingPoints.length]);

  const totals = useMemo(() => {
    let net = 0;
    let iva = 0;
    for (const it of items) {
      const lineNet = (Number(it.quantity) || 0) * (Number(it.unitNet) || 0);
      net += lineNet;
      iva += lineNet * ((Number(it.aliquot) || 0) / 100);
    }
    net = +net.toFixed(2);
    iva = +iva.toFixed(2);
    const total = +(net + iva).toFixed(2);
    return { net, iva, total };
  }, [items]);

  // Per-item unit_price cap ARCA enforces for monotributo/exento (Factura C)
  // emitters. When a line's unit price exceeds it, ARCA rejects the whole
  // invoice, so we warn proactively and explain how to split it.
  const isFacturaCEmitter =
    emitterIvaCondition === "monotributo" || emitterIvaCondition === "exento";
  // El tope solo aplica a PRODUCTOS. En servicio puro ARCA no restringe, así que
  // no avisamos ni bloqueamos. En "productos y servicios" lo mantenemos porque
  // la factura contiene productos.
  const capApplies = isFacturaCEmitter && itemType !== "service";
  const overCapItems = useMemo(() => {
    if (!capApplies) return [] as { index: number; minUnits: number }[];
    const out: { index: number; minUnits: number }[] = [];
    items.forEach((it, index) => {
      const unit = Number(it.unitNet) || 0;
      if (unit > MONOTRIBUTO_MAX_UNIT_PRICE) {
        const qty = Number(it.quantity) || 1;
        const lineNet = unit * qty;
        out.push({ index, minUnits: Math.ceil(lineNet / MONOTRIBUTO_MAX_UNIT_PRICE) });
      }
    });
    return out;
  }, [items, capApplies]);
  const hasOverCap = overCapItems.length > 0;

  const updateItem = (id: string, patch: Partial<DraftItem>) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  const addItem = () =>
    setItems((prev) => [
      ...prev,
      { id: newDraftItemId(), description: "", quantity: "1", unitNet: "", aliquot: emitterDiscriminatesIva ? 21 : 0 },
    ]);
  const removeItem = (id: string) =>
    setItems((prev) => (prev.length > 1 ? prev.filter((it) => it.id !== id) : prev));

  // When the invoice total diverges from the underlying movement amount we
  // surface this so the user is not surprised when, post-emission, the
  // movement gets re-synced to the invoice total (server-side behavior to
  // keep the PDF and the books in agreement — fix for Juan, 08/05/2026).
  const txAmountNum = Number((transaction as any)?.amount ?? 0);
  const amountWillChange =
    Number.isFinite(txAmountNum)
    && txAmountNum > 0
    && totals.total > 0
    && Math.abs(totals.total - txAmountNum) > 0.005;

  // Mirrors selectInvoiceDocType on the server (services/facturita.ts).
  // Monotributo / Exento emitters always emit Factura C regardless of receiver.
  // Responsable Inscripto emitters: FA si el receptor también es RI, FB si no.
  // Si todavía no tenemos la condición del emisor (carga inicial del
  // /api/invoicing/account), devolvemos null y la UI muestra "—" en vez de un
  // tipo arbitrario que después se contradiga con el que emite ARCA.
  const expectedDocType = useMemo<string | null>(() => {
    if (!emitterIvaCondition) return null;
    if (emitterIvaCondition === "responsable_inscripto") {
      return receiverIva === "responsable_inscripto" ? "FA" : "FB";
    }
    if (emitterIvaCondition === "monotributo" || emitterIvaCondition === "exento") {
      return "FC";
    }
    return null;
  }, [emitterIvaCondition, receiverIva]);

  const handleSubmit = async () => {
    if (!transaction?.id) return;
    if (!receiverName.trim()) {
      setErrorMsg("Ingresá el nombre del receptor");
      return;
    }
    const invalidItem = items.some(
      (it) => (Number(it.quantity) || 0) <= 0 || (Number(it.unitNet) || 0) <= 0,
    );
    if (invalidItem) {
      setErrorMsg("Cada ítem necesita una cantidad y un precio unitario mayores a 0");
      return;
    }
    if (!totals.net || totals.net <= 0) {
      setErrorMsg("El neto debe ser mayor a 0");
      return;
    }
    if (hasOverCap) {
      setErrorMsg(
        `Hay ítems cuyo precio unitario supera el máximo de ARCA para monotributo ($${MONOTRIBUTO_MAX_UNIT_PRICE.toLocaleString("es-AR")}). Dividilos en varios ítems o subí la cantidad antes de emitir.`,
      );
      return;
    }
    if (includesService) {
      if (!serviceFrom || !serviceTo || !paymentDueDate) {
        setErrorMsg("Para facturar servicios completá el período del servicio (desde y hasta) y el vencimiento de pago.");
        return;
      }
      if (serviceTo < serviceFrom) {
        setErrorMsg('La fecha "hasta" del servicio no puede ser anterior a la fecha "desde".');
        return;
      }
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const body = {
        receiver: {
          name: receiverName.trim(),
          taxId: receiverTaxId.trim() || null,
          ivaCondition: receiverIva,
          email: receiverEmail.trim() || null,
        },
        items: items.map((it) => ({
          description: it.description.trim() || "Servicio",
          quantity: Number(it.quantity) || 1,
          unitPriceNet: Number(it.unitNet) || 0,
          ivaAliquot: it.aliquot,
        })),
        observations: observations.trim() || null,
        ...(sellingPoint != null ? { sellingPoint } : {}),
        itemType,
        ...(includesService
          ? { serviceFrom, serviceTo, paymentDueDate }
          : {}),
      };

      const estimated = expectedDocType;

      const data: any = await fetchWithAuth(`/invoicing/transactions/${transaction.id}/emit`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      const realDocType: string | undefined = data?.docType;
      const base = `${realDocType || ""} ${data?.voucherNumber || ""} · CAE ${data?.cae || "OK"}`.trim();
      // Only mention the estimate if it actually diverged. Keeps the happy
      // path clean and surfaces a clear "FYI" when the UI hint was off.
      const diverged = !!(estimated && realDocType && estimated !== realDocType);
      toast({
        title: "Factura emitida",
        description: diverged
          ? `${base} · Se emitió como ${realDocType} (estimábamos ${estimated})`
          : base,
      });

      queryClient.invalidateQueries({ queryKey: ["transaction", transaction.id] });
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      queryClient.invalidateQueries({ queryKey: ["invoicing", "invoices"] });
      onEmitted?.();
      onOpenChange(false);
    } catch (err: any) {
      const raw =
        err?.body?.message ||
        err?.message ||
        "No se pudo emitir la factura";
      // ARCA rejects monotributo invoices whose per-item unit_price exceeds its
      // cap, returning a technical message that includes the real cap value
      // (e.g. "... supera el máximo permitido ... (613492)"). Surface a plain
      // explanation with the exact cap ARCA reported and what to do.
      const capMatch = /m[aá]ximo permitido[^()]*\((\d+)\)/i.exec(String(raw));
      if (capMatch) {
        const cap = Number(capMatch[1]);
        setErrorMsg(
          `ARCA rechazó la factura: para monotributo, el precio unitario de cada ítem no puede superar $${cap.toLocaleString("es-AR")}. Dividí el monto en varios ítems (o subí la cantidad) para que cada precio unitario quede por debajo de ese tope, y volvé a emitir.`,
        );
      } else {
        setErrorMsg(raw);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg w-[calc(100vw-1.5rem)] max-h-[90vh] overflow-y-auto p-4 sm:p-6" data-testid="dialog-emit-invoice">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5 text-pink-500" />
            Emitir factura electrónica
          </DialogTitle>
          <DialogDescription>
            Comprobante estimado: <strong data-testid="text-emit-expected-doctype">{expectedDocType ?? "—"}</strong>
            {expectedDocType == null && (
              <span className="text-muted-foreground"> · Revisá la condición frente al IVA del receptor</span>
            )}
            . {willBeSimulated
              ? 'Se generará un comprobante de prueba sin contactar a ARCA.'
              : 'Se enviará a ARCA en el ambiente configurado.'}
          </DialogDescription>
        </DialogHeader>

        {willBeSimulated && (
          <div
            className="rounded-lg border border-pink-300 bg-pink-50 dark:bg-pink-500/10 dark:border-pink-500/40 text-pink-700 dark:text-pink-300 p-3 text-sm flex gap-2"
            data-testid="alert-emit-simulated"
          >
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              <strong>Modo de pruebas interno.</strong> Esta factura se generará como
              <strong> SIMULADA</strong>, sin validez fiscal. Sirve para probar el
              flujo mientras ARCA no esté disponible.
            </span>
          </div>
        )}

        <div className="space-y-4">
          <div className="grid gap-2">
            <Label>Receptor *</Label>
            <Popover open={clientPickerOpen} onOpenChange={setClientPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  className={cn(
                    "w-full justify-between font-normal",
                    !selectedClientId && "text-muted-foreground"
                  )}
                  data-testid="combobox-emit-client"
                >
                  <span className="flex items-center gap-2 truncate">
                    <User className="h-4 w-4 shrink-0 opacity-60" />
                    {selectedClientId === "manual"
                      ? "Receptor manual"
                      : (() => {
                          const c = orgClients.find((c: any) => c.id === selectedClientId);
                          if (c) {
                            return (
                              <span className="truncate">
                                {c.name}
                                {c.taxId ? (
                                  <span className="text-muted-foreground"> · {c.taxId}</span>
                                ) : null}
                              </span>
                            );
                          }
                          return "Elegí un cliente o tipeá un CUIT…";
                        })()}
                  </span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command
                  filter={(value, search) => {
                    if (!search) return 1;
                    return value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
                  }}
                >
                  <CommandInput placeholder="Buscar por nombre, razón social o CUIT…" />
                  <CommandList className="max-h-[240px]">
                    <CommandEmpty>No se encontraron clientes.</CommandEmpty>
                    <CommandGroup>
                      <CommandItem
                        value="__manual__ receptor manual"
                        onSelect={() => {
                          setSelectedClientId("manual");
                          setReceiverName("");
                          setReceiverTaxId("");
                          setReceiverIva("consumidor_final");
                          setReceiverEmail("");
                          setClientPickerOpen(false);
                        }}
                        data-testid="option-emit-client-manual"
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4",
                            selectedClientId === "manual" ? "opacity-100" : "opacity-0"
                          )}
                        />
                        <span className="text-primary">Receptor manual (tipear datos)</span>
                      </CommandItem>
                    </CommandGroup>
                    {orgClients.length > 0 && (
                      <CommandGroup heading="Mis clientes">
                        {orgClients.map((c: any) => {
                          const searchValue = `${c.name || ''} ${c.taxId || ''} ${c.email || ''}`.trim();
                          return (
                            <CommandItem
                              key={c.id}
                              value={searchValue}
                              onSelect={() => {
                                setSelectedClientId(c.id);
                                setReceiverName(c.name || "");
                                setReceiverTaxId(c.taxId || "");
                                const iva: IvaCondition =
                                  (c.ivaCondition as IvaCondition) ||
                                  (c.taxId && /^\d{11}$/.test(String(c.taxId)) ? "responsable_inscripto" : "consumidor_final");
                                setReceiverIva(iva);
                                setReceiverEmail(c.email || "");
                                setClientPickerOpen(false);
                              }}
                              data-testid={`option-emit-client-${c.id}`}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  selectedClientId === c.id ? "opacity-100" : "opacity-0"
                                )}
                              />
                              <div className="flex flex-col min-w-0">
                                <span className="truncate">{c.name || 'Cliente'}</span>
                                {(c.taxId || c.email) && (
                                  <span className="text-xs text-muted-foreground truncate">
                                    {c.taxId || ''}{c.taxId && c.email ? ' · ' : ''}{c.email || ''}
                                  </span>
                                )}
                              </div>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <Input
              value={receiverName}
              onChange={(e) => { receiverTouchedRef.current = true; setReceiverName(e.target.value); }}
              placeholder="Razón social / Nombre"
              data-testid="input-emit-receiver-name"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">CUIT / DNI</Label>
                <Input
                  value={receiverTaxId}
                  onChange={(e) => { receiverTouchedRef.current = true; setReceiverTaxId(e.target.value); }}
                  placeholder="CUIT / DNI"
                  data-testid="input-emit-receiver-taxid"
                />
              </div>
              <div>
                <div className="flex items-center gap-1">
                  <Label className="text-xs">Condición frente al IVA</Label>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground"
                          aria-label="Ayuda sobre condición frente al IVA"
                          data-testid="tooltip-emit-iva-help"
                        >
                          <HelpCircle className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs text-xs">
                        Es la condición del receptor frente al IVA. Si no estás
                        seguro, dejá <strong>Consumidor Final</strong>. Para
                        facturar a empresas con CUIT, elegí{" "}
                        <strong>Responsable Inscripto</strong> o{" "}
                        <strong>Monotributo</strong> según corresponda. Si elegís
                        mal, ARCA puede rechazar la factura.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <Select value={receiverIva} onValueChange={(v) => { receiverTouchedRef.current = true; setReceiverIva(v as IvaCondition); }}>
                  <SelectTrigger data-testid="select-emit-receiver-iva">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {IVA_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Input
              value={receiverEmail}
              onChange={(e) => { receiverTouchedRef.current = true; setReceiverEmail(e.target.value); }}
              placeholder="Email (opcional)"
              type="email"
              data-testid="input-emit-receiver-email"
            />
          </div>

          {(activeSellingPoints.length > 0 || sellingPoint != null || defaultSellingPoint != null) && (
            <div className="grid gap-2 border-t pt-4">
              <Label>Punto de venta {activeSellingPoints.length > 1 ? "*" : ""}</Label>
              {activeSellingPoints.length > 1 ? (
                <>
                  <Select
                    value={sellingPoint != null ? String(sellingPoint) : ""}
                    onValueChange={(v) => setSellingPoint(Number(v))}
                  >
                    <SelectTrigger data-testid="select-emit-selling-point">
                      <SelectValue placeholder="Elegí un punto de venta" />
                    </SelectTrigger>
                    <SelectContent>
                      {activeSellingPoints.map((sp) => (
                        <SelectItem key={sp.number} value={String(sp.number)}>
                          {String(sp.number).padStart(5, "0")}
                          {sp.description ? ` · ${sp.description}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Tu CUIT tiene varios puntos de venta habilitados en ARCA.
                    {sellingPoint != null && defaultSellingPoint != null && sellingPoint === defaultSellingPoint
                      ? " Estás usando el predeterminado — podés cambiarlo sólo para esta factura."
                      : " Elegí con cuál querés emitir esta factura."}
                  </p>
                </>
              ) : (() => {
                const effective = sellingPoint ?? defaultSellingPoint ?? activeSellingPoints[0]?.number ?? null;
                const match = activeSellingPoints.find((sp) => sp.number === effective);
                return (
                  <div
                    className="rounded-md border bg-muted/40 px-3 py-2 text-sm flex items-center justify-between gap-2"
                    data-testid="text-emit-selling-point"
                  >
                    <span>
                      <strong>{effective != null ? String(effective).padStart(5, "0") : "—"}</strong>
                      {match?.description ? (
                        <span className="text-muted-foreground"> · {match.description}</span>
                      ) : null}
                    </span>
                    <span className="text-xs text-muted-foreground">Predeterminado</span>
                  </div>
                );
              })()}
            </div>
          )}

          <div className="grid gap-2 border-t pt-4">
            <Label>¿Qué estás facturando?</Label>
            <Select value={itemType} onValueChange={(v) => setItemType(v as ItemType)}>
              <SelectTrigger data-testid="select-emit-item-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="product">Producto</SelectItem>
                <SelectItem value="service">Servicio</SelectItem>
                <SelectItem value="product_and_service">Productos y servicios</SelectItem>
              </SelectContent>
            </Select>
            {includesService && (
              <div className="grid gap-2 rounded-lg border border-dashed p-3">
                <p className="text-xs text-muted-foreground">
                  Para facturar servicios, ARCA pide el período del servicio y el
                  vencimiento de pago.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div>
                    <Label className="text-xs">Servicio desde *</Label>
                    <Input
                      type="date"
                      value={serviceFrom}
                      onChange={(e) => setServiceFrom(e.target.value)}
                      data-testid="input-emit-service-from"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Servicio hasta *</Label>
                    <Input
                      type="date"
                      value={serviceTo}
                      onChange={(e) => setServiceTo(e.target.value)}
                      data-testid="input-emit-service-to"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Vencimiento de pago *</Label>
                    <Input
                      type="date"
                      value={paymentDueDate}
                      onChange={(e) => setPaymentDueDate(e.target.value)}
                      data-testid="input-emit-payment-due"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="grid gap-3 border-t pt-4">
            <div className="flex items-center justify-between gap-2">
              <Label>Detalle</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addItem}
                data-testid="button-emit-add-item"
              >
                <Plus className="h-4 w-4 mr-1" /> Agregar ítem
              </Button>
            </div>

            {items.map((it, index) => {
              const lineUnit = Number(it.unitNet) || 0;
              const lineOverCap = capApplies && lineUnit > MONOTRIBUTO_MAX_UNIT_PRICE;
              return (
                <div
                  key={it.id}
                  className="rounded-lg border p-3 grid gap-2"
                  data-testid={`row-emit-item-${index}`}
                >
                  <div className="flex items-center gap-2">
                    <Input
                      value={it.description}
                      onChange={(e) => updateItem(it.id, { description: e.target.value })}
                      placeholder="Descripción del ítem"
                      data-testid={`input-emit-item-desc-${index}`}
                    />
                    {items.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => removeItem(it.id)}
                        aria-label="Quitar ítem"
                        data-testid={`button-emit-remove-item-${index}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <div>
                      <Label className="text-xs">Cantidad</Label>
                      <Input
                        type="number"
                        inputMode="decimal"
                        value={it.quantity}
                        onChange={(e) => updateItem(it.id, { quantity: e.target.value })}
                        data-testid={`input-emit-item-qty-${index}`}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Precio unitario</Label>
                      <Input
                        type="number"
                        inputMode="decimal"
                        value={it.unitNet}
                        onChange={(e) => updateItem(it.id, { unitNet: e.target.value })}
                        className={cn(lineOverCap && "border-red-400 focus-visible:ring-red-400")}
                        data-testid={`input-emit-item-unit-${index}`}
                      />
                    </div>
                    <div className="col-span-2 sm:col-span-1">
                      <Label className="text-xs">Alícuota IVA</Label>
                      <Select
                        value={String(it.aliquot)}
                        onValueChange={(v) => updateItem(it.id, { aliquot: Number(v) })}
                        disabled={!emitterDiscriminatesIva}
                      >
                        <SelectTrigger data-testid={`select-emit-item-aliquot-${index}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(emitterDiscriminatesIva ? ALIQUOT_OPTIONS : [0]).map((a) => (
                            <SelectItem key={a} value={String(a)}>{a}%</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {!emitterDiscriminatesIva && index === 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      Factura C no discrimina IVA.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <div className="rounded-lg bg-muted/40 p-3 text-sm grid grid-cols-3 gap-2 text-xs sm:text-sm">
            <div><span className="text-muted-foreground block text-xs">Neto</span><strong data-testid="text-emit-net">${totals.net.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</strong></div>
            <div><span className="text-muted-foreground block text-xs">IVA</span><strong data-testid="text-emit-iva">${totals.iva.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</strong></div>
            <div><span className="text-muted-foreground block text-xs">Total</span><strong data-testid="text-emit-total">${totals.total.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</strong></div>
          </div>

          {hasOverCap && (
            <div
              className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-500/10 dark:border-red-500/40 text-red-800 dark:text-red-200 p-3 text-xs sm:text-sm flex gap-2"
              data-testid="alert-emit-monotributo-cap"
            >
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <div className="space-y-1">
                <p>
                  <strong>ARCA no va a aceptar esta factura.</strong> Para monotributo, el
                  precio unitario de cada ítem no puede superar{" "}
                  <strong>${MONOTRIBUTO_MAX_UNIT_PRICE.toLocaleString("es-AR")}</strong>.
                </p>
                <p>
                  {overCapItems.length === 1
                    ? `El ítem ${overCapItems[0].index + 1} lo supera. `
                    : `Hay ${overCapItems.length} ítems que lo superan. `}
                  Dividilo en varios ítems o subí la cantidad para que cada precio unitario
                  quede por debajo del tope
                  {overCapItems.length === 1
                    ? ` (necesitás al menos ${overCapItems[0].minUnits} ${overCapItems[0].minUnits === 1 ? "unidad o ítem" : "unidades o ítems"})`
                    : ""}
                  .
                </p>
              </div>
            </div>
          )}

          {amountWillChange && (
            <div
              className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/40 text-amber-800 dark:text-amber-200 p-3 text-xs sm:text-sm flex gap-2"
              data-testid="alert-emit-amount-sync"
            >
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                El monto del movimiento (
                <strong>${txAmountNum.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</strong>
                ) se actualizará al total facturado (
                <strong>${totals.total.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</strong>
                ) para que la factura y tus libros queden alineados.
              </span>
            </div>
          )}

          <div className="grid gap-2">
            <Label className="text-xs">Observaciones (opcional)</Label>
            <Textarea
              rows={2}
              value={observations}
              onChange={(e) => setObservations(e.target.value)}
              data-testid="input-emit-observations"
            />
          </div>

          {errorMsg && (
            <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 p-3 text-sm flex gap-2" data-testid="text-emit-error">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col-reverse sm:flex-row gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting} data-testid="button-emit-cancel" className="w-full sm:w-auto">
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || hasOverCap} data-testid="button-emit-confirm" className="w-full sm:w-auto">
            {submitting ? (<><Loader2 className="h-4 w-4 animate-spin mr-2" /> Emitiendo…</>) : "Emitir"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
