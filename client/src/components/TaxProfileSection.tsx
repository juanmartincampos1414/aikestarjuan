import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { fetchWithAuth } from '@/lib/api';
import { TAX_IVA_CONDITIONS, TAX_IVA_CONDITION_LABELS, MONOTRIBUTO_CATEGORIES } from '@shared/schema';

interface TaxProfile {
  id?: string;
  ivaCondition?: string | null;
  monotributoCategory?: string | null;
  iibbInscribed: boolean;
  iibbJurisdictions?: string | null;
  iibbNumber?: string | null;
  iibbAliquot?: string | null;
  gananciasInscribed: boolean;
  gananciasNumber?: string | null;
  gananciasRegime?: string | null;
  otherTaxes?: string | null;
  notes?: string | null;
}

const DEFAULT: TaxProfile = {
  ivaCondition: null,
  monotributoCategory: null,
  iibbInscribed: false,
  iibbJurisdictions: '',
  iibbNumber: '',
  iibbAliquot: '',
  gananciasInscribed: false,
  gananciasNumber: '',
  gananciasRegime: '',
  otherTaxes: '',
  notes: '',
};

export default function TaxProfileSection({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<TaxProfile>(DEFAULT);

  const { data, isLoading } = useQuery<TaxProfile | null>({
    queryKey: ['/api/tax-profile'],
    queryFn: async () => {
      return await fetchWithAuth('/tax-profile');
    },
  });

  useEffect(() => {
    if (data) {
      setForm({
        ...DEFAULT,
        ...data,
        iibbInscribed: !!data.iibbInscribed,
        gananciasInscribed: !!data.gananciasInscribed,
      });
    }
  }, [data]);

  const save = useMutation<TaxProfile, Error, void>({
    mutationFn: async () => {
      const payload: Record<string, unknown> = { ...form };
      // Empty strings -> null
      for (const k of Object.keys(payload)) {
        if (payload[k] === '') payload[k] = null;
      }
      return await fetchWithAuth('/tax-profile', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      toast({ title: 'Condiciones impositivas guardadas' });
      queryClient.invalidateQueries({ queryKey: ['/api/tax-profile'] });
      queryClient.invalidateQueries({ queryKey: ['/api/taxes/summary'] });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  if (isLoading) return <div className="text-sm text-muted-foreground">Cargando…</div>;

  return (
    <div className="space-y-6" data-testid="tax-profile-section">
      <p className="text-sm text-muted-foreground">
        Esta información se usa para calcular y mostrar tributos en la sección Impuestos. No reemplaza la presentación oficial ante AFIP/ARCA.
      </p>

      {/* IVA */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <h3 className="font-semibold flex items-center gap-2">IVA</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>Condición frente al IVA</Label>
              <Select
                value={form.ivaCondition || ''}
                onValueChange={(v) => setForm({ ...form, ivaCondition: v || null, monotributoCategory: v === 'monotributo' ? form.monotributoCategory : null })}
                disabled={!canEdit}
              >
                <SelectTrigger data-testid="select-iva-condition"><SelectValue placeholder="Seleccionar…" /></SelectTrigger>
                <SelectContent>
                  {TAX_IVA_CONDITIONS.map(c => (
                    <SelectItem key={c} value={c}>{TAX_IVA_CONDITION_LABELS[c]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {form.ivaCondition === 'monotributo' && (
              <div>
                <Label>Categoría Monotributo</Label>
                <Select value={form.monotributoCategory || ''} onValueChange={(v) => setForm({ ...form, monotributoCategory: v })} disabled={!canEdit}>
                  <SelectTrigger data-testid="select-monotributo-category"><SelectValue placeholder="Seleccionar…" /></SelectTrigger>
                  <SelectContent>
                    {MONOTRIBUTO_CATEGORIES.map(c => <SelectItem key={c} value={c}>Categoría {c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* IIBB */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Ingresos Brutos (IIBB)</h3>
            <Switch checked={form.iibbInscribed} onCheckedChange={(v) => setForm({ ...form, iibbInscribed: v })} disabled={!canEdit} data-testid="switch-iibb-inscribed" />
          </div>
          {form.iibbInscribed && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label>N° de inscripción</Label>
                <Input value={form.iibbNumber || ''} onChange={e => setForm({ ...form, iibbNumber: e.target.value })} disabled={!canEdit} data-testid="input-iibb-number" />
              </div>
              <div>
                <Label>Jurisdicciones</Label>
                <Input value={form.iibbJurisdictions || ''} onChange={e => setForm({ ...form, iibbJurisdictions: e.target.value })} placeholder="CABA, Buenos Aires…" disabled={!canEdit} data-testid="input-iibb-jurisdictions" />
              </div>
              <div>
                <Label>Alícuota promedio (%)</Label>
                <Input type="number" step="0.01" value={form.iibbAliquot || ''} onChange={e => setForm({ ...form, iibbAliquot: e.target.value })} disabled={!canEdit} data-testid="input-iibb-aliquot" />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Ganancias */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Impuesto a las Ganancias</h3>
            <Switch checked={form.gananciasInscribed} onCheckedChange={(v) => setForm({ ...form, gananciasInscribed: v })} disabled={!canEdit} data-testid="switch-ganancias-inscribed" />
          </div>
          {form.gananciasInscribed && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>N° de inscripción</Label>
                <Input value={form.gananciasNumber || ''} onChange={e => setForm({ ...form, gananciasNumber: e.target.value })} disabled={!canEdit} data-testid="input-ganancias-number" />
              </div>
              <div>
                <Label>Régimen</Label>
                <Input value={form.gananciasRegime || ''} onChange={e => setForm({ ...form, gananciasRegime: e.target.value })} placeholder="Persona física, sociedad…" disabled={!canEdit} data-testid="input-ganancias-regime" />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Otros */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <h3 className="font-semibold">Otros tributos y notas</h3>
          <div>
            <Label>Otros tributos (texto libre)</Label>
            <Textarea value={form.otherTaxes || ''} onChange={e => setForm({ ...form, otherTaxes: e.target.value })} placeholder="Ej: Impuesto a los débitos y créditos, percepciones específicas…" disabled={!canEdit} data-testid="input-other-taxes" />
          </div>
          <div>
            <Label>Notas</Label>
            <Textarea value={form.notes || ''} onChange={e => setForm({ ...form, notes: e.target.value })} disabled={!canEdit} data-testid="input-tax-notes" />
          </div>
        </CardContent>
      </Card>

      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-tax-profile">
            {save.isPending ? 'Guardando…' : 'Guardar condiciones'}
          </Button>
        </div>
      )}
    </div>
  );
}
