import React from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { employeeAPI, clientAPI } from '@/lib/api';
import { useMembership } from '@/lib/hooks';
import { ROLE_PERMISSIONS, type Role, CONTRACT_TYPE_LABELS, EMPLOYEE_STATUSES, CONTRACT_TYPES, CURRENCY_SYMBOLS } from '@shared/schema';
import type { Employee, Client } from '@shared/schema';

type EmployeeWithAllocations = Employee & {
  allocations?: { clientId: string; clientName: string; projectName?: string; percentage: string; commissionRate?: string }[];
};
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useUndoDelete } from '@/hooks/use-undo-delete';
import { Users, Plus, Trash2, Pencil, MoreVertical, ShieldAlert, Search, UserCheck, UserX, DollarSign, X, Maximize2, Minimize2, TrendingUp } from 'lucide-react';
import { BackButton } from '@/components/BackButton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { format } from 'date-fns';
import { normalizeAmountInput, formatAmountLive } from '@/lib/currency';
import { cn } from '@/lib/utils';

const employeeSchema = z.object({
  fullName: z.string().min(2, 'El nombre es requerido'),
  dni: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email('Email inválido').optional().or(z.literal('')),
  birthDate: z.string().optional(),
  startDate: z.string().optional(),
  contractType: z.enum(['indefinite', 'temporary', 'freelance']).default('indefinite'),
  grossSalary: z.string().default('0'),
  netSalary: z.string().default('0'),
  currency: z.string().default('ARS'),
  status: z.enum(['active', 'inactive']).default('active'),
  notes: z.string().optional(),
});

type EmployeeFormValues = z.infer<typeof employeeSchema>;

const SalaryInput = React.forwardRef<HTMLInputElement, {
  value: string;
  onChange: (value: string) => void;
  'data-testid'?: string;
}>(({ value, onChange, ...props }, ref) => {
  return (
    <Input
      ref={ref}
      type="text"
      inputMode="decimal"
      placeholder="0"
      value={value}
      onChange={(e) => {
        const { displayValue } = formatAmountLive(e.target.value, value);
        onChange(displayValue);
      }}
      data-testid={props['data-testid']}
    />
  );
});
SalaryInput.displayName = 'SalaryInput';

function EmployeeFormFields({ formInstance }: { formInstance: ReturnType<typeof useForm<EmployeeFormValues>> }) {
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-4">
        <FormField control={formInstance.control} name="fullName" render={({ field }) => (
          <FormItem>
            <FormLabel>Nombre completo *</FormLabel>
            <FormControl><Input {...field} data-testid="input-employee-name" /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={formInstance.control} name="dni" render={({ field }) => (
          <FormItem>
            <FormLabel>DNI / Documento</FormLabel>
            <FormControl><Input {...field} data-testid="input-employee-dni" /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <FormField control={formInstance.control} name="email" render={({ field }) => (
          <FormItem>
            <FormLabel>Email</FormLabel>
            <FormControl><Input type="email" {...field} data-testid="input-employee-email" /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={formInstance.control} name="phone" render={({ field }) => (
          <FormItem>
            <FormLabel>Teléfono</FormLabel>
            <FormControl><Input {...field} data-testid="input-employee-phone" /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <FormField control={formInstance.control} name="birthDate" render={({ field }) => (
          <FormItem>
            <FormLabel>Fecha de nacimiento</FormLabel>
            <FormControl><Input type="date" {...field} data-testid="input-employee-birthdate" /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={formInstance.control} name="startDate" render={({ field }) => (
          <FormItem>
            <FormLabel>Fecha de ingreso</FormLabel>
            <FormControl><Input type="date" {...field} data-testid="input-employee-startdate" /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <FormField control={formInstance.control} name="contractType" render={({ field }) => (
          <FormItem>
            <FormLabel>Tipo de contrato</FormLabel>
            <Select onValueChange={field.onChange} value={field.value}>
              <FormControl><SelectTrigger data-testid="select-contract-type"><SelectValue /></SelectTrigger></FormControl>
              <SelectContent>
                {CONTRACT_TYPES.map(ct => (
                  <SelectItem key={ct} value={ct}>{CONTRACT_TYPE_LABELS[ct]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={formInstance.control} name="status" render={({ field }) => (
          <FormItem>
            <FormLabel>Estado</FormLabel>
            <Select onValueChange={field.onChange} value={field.value}>
              <FormControl><SelectTrigger data-testid="select-employee-status"><SelectValue /></SelectTrigger></FormControl>
              <SelectContent>
                <SelectItem value="active">Activo</SelectItem>
                <SelectItem value="inactive">Inactivo</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )} />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <FormField control={formInstance.control} name="grossSalary" render={({ field }) => (
          <FormItem>
            <FormLabel>Sueldo bruto</FormLabel>
            <FormControl>
              <SalaryInput value={field.value} onChange={field.onChange} data-testid="input-gross-salary" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={formInstance.control} name="netSalary" render={({ field }) => (
          <FormItem>
            <FormLabel>Sueldo neto</FormLabel>
            <FormControl>
              <SalaryInput value={field.value} onChange={field.onChange} data-testid="input-net-salary" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={formInstance.control} name="currency" render={({ field }) => (
          <FormItem>
            <FormLabel>Moneda</FormLabel>
            <Select onValueChange={field.onChange} value={field.value}>
              <FormControl><SelectTrigger data-testid="select-salary-currency"><SelectValue /></SelectTrigger></FormControl>
              <SelectContent>
                <SelectItem value="ARS">ARS ($)</SelectItem>
                <SelectItem value="USD">USD (US$)</SelectItem>
                <SelectItem value="EUR">EUR (€)</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )} />
      </div>
      <FormField control={formInstance.control} name="notes" render={({ field }) => (
        <FormItem>
          <FormLabel>Notas</FormLabel>
          <FormControl><Textarea {...field} rows={2} data-testid="input-employee-notes" /></FormControl>
          <FormMessage />
        </FormItem>
      )} />
    </div>
  );
}

type AllocationItem = { clientId: string; projectId: string; projectName: string; percentage: string; commissionRate: string };

function cleanDecimal(v: string): string {
  const n = parseFloat(v);
  if (isNaN(n)) return v;
  return n % 1 === 0 ? String(Math.round(n)) : String(n);
}

function AllocationProjectSelect({ clientId, value, onChange, testId }: { clientId: string; value: string; onChange: (projectId: string, projectName: string) => void; testId: string }) {
  const { data: projects = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['/api/clients', clientId, 'projects'],
    queryFn: () => clientAPI.getProjects(clientId),
    enabled: !!clientId,
  });

  if (projects.length === 0) {
    return <span className="text-[10px] text-muted-foreground italic flex-1">Sin proyectos en este cliente</span>;
  }

  return (
    <Select
      value={value || '__none__'}
      onValueChange={(v) => {
        if (v === '__none__') {
          onChange('', '');
        } else {
          const proj = projects.find(p => p.id === v);
          onChange(v, proj?.name || '');
        }
      }}
    >
      <SelectTrigger className="flex-1 h-8 text-xs" data-testid={testId}>
        <SelectValue placeholder="Sin proyecto" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">Sin proyecto</SelectItem>
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AllocationEditor({ value, onChange, clients }: {
  value: AllocationItem[];
  onChange: (v: AllocationItem[]) => void;
  clients: Client[];
}) {
  const activeClients = clients.filter((c: Client) => c.isActive);
  const totalPct = value.reduce((sum, a) => sum + parseFloat(a.percentage || '0'), 0);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Asignación a clientes</span>
        {activeClients.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              const newList = [...value, { clientId: activeClients[0].id, projectId: '', projectName: '', percentage: '100', commissionRate: '0' }];
              const base = Math.floor(100 / newList.length);
              const remainder = 100 - base * newList.length;
              onChange(newList.map((a, i) => ({ ...a, percentage: (base + (i < remainder ? 1 : 0)).toString() })));
            }}
            data-testid="button-add-allocation"
          >
            <Plus className="h-3 w-3 mr-1" /> Agregar cliente
          </Button>
        )}
      </div>
      {value.length === 0 ? (
        <p className="text-xs text-muted-foreground">Sin clientes asignados.</p>
      ) : (
        <div className="space-y-3">
          {value.map((alloc, idx) => (
            <div key={idx} className="rounded-lg border p-3 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Cliente</label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={() => {
                    const newList = value.filter((_, i) => i !== idx);
                    if (newList.length > 0) {
                      const base = Math.floor(100 / newList.length);
                      const remainder = 100 - base * newList.length;
                      onChange(newList.map((a, i) => ({ ...a, percentage: (base + (i < remainder ? 1 : 0)).toString() })));
                    } else {
                      onChange(newList);
                    }
                  }}
                  data-testid={`button-remove-allocation-${idx}`}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
              <Select
                value={alloc.clientId}
                onValueChange={(v) => {
                  const updated = [...value];
                  updated[idx] = { ...updated[idx], clientId: v, projectId: '', projectName: '' };
                  onChange(updated);
                }}
              >
                <SelectTrigger data-testid={`select-allocation-client-${idx}`}>
                  <SelectValue placeholder="Seleccionar cliente" />
                </SelectTrigger>
                <SelectContent>
                  {activeClients.map((c: Client) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Proyecto (opcional)</label>
                  <AllocationProjectSelect
                    clientId={alloc.clientId}
                    value={alloc.projectId}
                    onChange={(projectId, projectName) => {
                      const updated = [...value];
                      updated[idx] = { ...updated[idx], projectId, projectName };
                      onChange(updated);
                    }}
                    testId={`select-allocation-project-${idx}`}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs font-medium text-muted-foreground whitespace-nowrap">Comisión sobre ingresos:</label>
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    className="w-16 h-8 text-xs"
                    value={cleanDecimal(alloc.commissionRate)}
                    onChange={(e) => {
                      const updated = [...value];
                      updated[idx] = { ...updated[idx], commissionRate: e.target.value };
                      onChange(updated);
                    }}
                    data-testid={`input-allocation-commission-${idx}`}
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>
                <Input
                  type="hidden"
                  value={alloc.percentage}
                  data-testid={`input-allocation-pct-${idx}`}
                />
              </div>
            </div>
          ))}
          {false && totalPct !== 100 && value.length > 0 && (
            <p className="text-xs text-amber-500">Total dedicación: {totalPct}%</p>
          )}
        </div>
      )}
    </div>
  );
}

interface EmployeeProfitability {
  employeeId: string;
  fullName: string;
  grossSalary: string;
  currency: string;
  period: string;
  totalCommissions: string;
  totalEarnings: string;
  clients: {
    clientId: string;
    clientName: string;
    projectName: string;
    percentage: string;
    commissionRate: string;
    costProportion: string;
    clientTotalRevenue: string;
    employeeRevenue: string;
    commission: string;
    transactions?: {
      date: string;
      amount: string;
      description: string;
      transactionNumber: string;
    }[];
  }[];
}

function EmployeeProfitabilitySection({ employeeId }: { employeeId: string }) {
  const { data: profitability, isLoading } = useQuery<EmployeeProfitability>({
    queryKey: ['/api/employees', employeeId, 'profitability'],
    queryFn: () => employeeAPI.getProfitability(employeeId),
    enabled: !!employeeId,
  });

  if (isLoading) {
    return (
      <div className="py-2">
        <p className="text-xs text-muted-foreground">Calculando acumulado...</p>
      </div>
    );
  }

  if (!profitability || profitability.clients.length === 0) {
    return null;
  }

  const grossSalary = parseFloat(profitability.grossSalary) || 0;
  const totalCommissions = parseFloat(profitability.totalCommissions) || 0;
  const totalEarnings = parseFloat(profitability.totalEarnings) || 0;
  const currency = profitability.currency || 'ARS';
  const symbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || '$';

  const formatMoney = (val: number) => `${symbol} ${Math.abs(val).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  const periodLabel = profitability.period
    ? new Date(profitability.period + '-01').toLocaleString('es-AR', { month: 'long', year: 'numeric' })
    : '';

  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-xs text-muted-foreground font-medium flex items-center gap-1.5">
        <TrendingUp className="h-3.5 w-3.5" />
        Acumulado mensual
        {periodLabel && <span className="text-[10px] font-normal">({periodLabel})</span>}
      </p>
      <div className="flex items-center gap-1">
        <div className="rounded-lg border px-3 py-2 flex-1" data-testid="emp-profitability-salary">
          <p className="text-[10px] text-muted-foreground">Sueldo fijo</p>
          <p className="text-sm font-mono font-bold">{formatMoney(grossSalary)}</p>
        </div>
        <span className="text-muted-foreground font-bold text-sm">+</span>
        <div className="rounded-lg border px-3 py-2 flex-1" data-testid="emp-profitability-commissions">
          <p className="text-[10px] text-muted-foreground">Comisiones</p>
          <p className={`text-sm font-mono font-bold ${totalCommissions > 0 ? 'text-green-500' : 'text-muted-foreground'}`}>
            {formatMoney(totalCommissions)}
          </p>
        </div>
        <span className="text-muted-foreground font-bold text-sm">=</span>
        <div className="rounded-lg border px-3 py-2 flex-1 border-cyan-500/30 bg-cyan-500/5" data-testid="emp-profitability-total">
          <p className="text-[10px] text-muted-foreground">Total</p>
          <p className="text-sm font-mono font-bold text-cyan-400">{formatMoney(totalEarnings)}</p>
        </div>
      </div>
      {profitability.clients.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground mt-1">Comisiones por cliente</p>
          {profitability.clients.map((c, idx) => {
            const comm = parseFloat(c.commission) || 0;
            const eRevenue = parseFloat(c.employeeRevenue) || 0;
            const commRate = parseFloat(c.commissionRate) || 0;
            return (
              <div key={`${c.clientId}-${idx}`} className="rounded border px-2.5 py-2 text-xs" data-testid={`emp-client-commission-${c.clientId}-${idx}`}>
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <span className="font-medium truncate">{c.clientName}</span>
                    {c.projectName && <span className="text-muted-foreground"> / {c.projectName}</span>}
                  </div>
                  <span className={`font-mono font-semibold ${comm > 0 ? 'text-green-500' : 'text-muted-foreground'}`}>
                    {comm > 0 ? `+${formatMoney(comm)}` : formatMoney(0)}
                  </span>
                </div>
                {c.transactions && c.transactions.length > 0 && (
                  <div className="mt-1.5 space-y-0.5 border-t pt-1.5">
                    {c.transactions.map((tx, txIdx) => (
                      <div key={txIdx} className="flex items-center justify-between text-[10px] text-muted-foreground" data-testid={`commission-tx-${c.clientId}-${txIdx}`}>
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="shrink-0">{(() => { try { return format(new Date(tx.date), 'dd/MM/yy HH:mm'); } catch { return tx.date; } })()}</span>
                          <span className="truncate">{tx.description}</span>
                        </div>
                        <span className="font-mono shrink-0 ml-2">{formatMoney(parseFloat(tx.amount))}</span>
                      </div>
                    ))}
                  </div>
                )}
                {commRate > 0 && (
                  <p className="text-[10px] text-muted-foreground mt-1 border-t pt-1">
                    Ingreso proporcional: {formatMoney(eRevenue)} x {commRate}% comisión = {formatMoney(comm)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function HRPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { showUndoToast } = useUndoDelete();
  const { data: membership } = useMembership();
  const [isOpen, setIsOpen] = React.useState(false);
  const [editEmployee, setEditEmployee] = React.useState<Employee | null>(null);
  const [viewEmployee, setViewEmployee] = React.useState<EmployeeWithAllocations | null>(null);
  const [viewMaximized, setViewMaximized] = React.useState(false);
  const [createMaximized, setCreateMaximized] = React.useState(false);
  const [editMaximized, setEditMaximized] = React.useState(false);
  const [deleteEmployeeId, setDeleteEmployeeId] = React.useState<string | null>(null);
  const [searchTerm, setSearchTerm] = React.useState('');
  const [filterStatus, setFilterStatus] = React.useState<string>('all');
  const [filterContract, setFilterContract] = React.useState<string>('all');
  const [allocations, setAllocations] = React.useState<AllocationItem[]>([]);
  const [editAllocations, setEditAllocations] = React.useState<AllocationItem[]>([]);

  const userRole = (membership?.role as Role) || 'viewer';
  const userPermissions = ROLE_PERMISSIONS[userRole] || [];
  const canCreate = userPermissions.includes('transactions:create');

  const { data: employees = [], isLoading } = useQuery<EmployeeWithAllocations[]>({
    queryKey: ['/api/employees'],
    queryFn: () => employeeAPI.getAll(),
  });

  const { data: clients = [] } = useQuery<Client[]>({
    queryKey: ['/api/clients'],
    queryFn: () => clientAPI.getAll(true),
  });

  const createMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const result = await employeeAPI.create(data);
      if (result?.id && allocations.length > 0) {
        await employeeAPI.setAllocations(result.id, allocations);
      }
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/employees'] });
      toast({ title: "Empleado creado", description: "El empleado ha sido registrado exitosamente." });
      setIsOpen(false);
      setCreateMaximized(false);
      setAllocations([]);
      form.reset();
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Record<string, unknown> }) => {
      const result = await employeeAPI.update(id, data);
      await employeeAPI.setAllocations(id, editAllocations);
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/employees'] });
      toast({ title: "Empleado actualizado" });
      setEditEmployee(null);
      setEditMaximized(false);
      setEditAllocations([]);
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: employeeAPI.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/employees'] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleDeleteEmployee = async () => {
    if (!deleteEmployeeId) return;
    const empName = employees.find((e) => e.id === deleteEmployeeId)?.fullName;
    try {
      const result = await deleteMutation.mutateAsync(deleteEmployeeId);
      setDeleteEmployeeId(null);
      if (result?.undoKey) {
        showUndoToast(result.undoKey, 'employee', empName);
      }
    } catch {}
  };

  const form = useForm<EmployeeFormValues>({
    resolver: zodResolver(employeeSchema),
    defaultValues: { fullName: '', dni: '', phone: '', email: '', birthDate: '', startDate: '', contractType: 'indefinite', grossSalary: '0', netSalary: '0', currency: 'ARS', status: 'active', notes: '' },
  });

  const editForm = useForm<EmployeeFormValues>({
    resolver: zodResolver(employeeSchema),
    defaultValues: { fullName: '', dni: '', phone: '', email: '', birthDate: '', startDate: '', contractType: 'indefinite', grossSalary: '0', netSalary: '0', currency: 'ARS', status: 'active', notes: '' },
  });

  const onSubmit = (data: EmployeeFormValues) => {
    createMutation.mutate({
      fullName: data.fullName,
      dni: data.dni || undefined,
      phone: data.phone || undefined,
      email: data.email || undefined,
      birthDate: data.birthDate || undefined,
      startDate: data.startDate || undefined,
      contractType: data.contractType,
      grossSalary: String(normalizeAmountInput(data.grossSalary || '0')),
      netSalary: String(normalizeAmountInput(data.netSalary || '0')),
      currency: data.currency,
      status: data.status,
      notes: data.notes || undefined,
    });
  };

  const handleEditOpen = async (emp: EmployeeWithAllocations) => {
    editForm.reset({
      fullName: emp.fullName,
      dni: emp.dni || '',
      phone: emp.phone || '',
      email: emp.email || '',
      birthDate: emp.birthDate ? format(new Date(emp.birthDate), 'yyyy-MM-dd') : '',
      startDate: emp.startDate ? format(new Date(emp.startDate), 'yyyy-MM-dd') : '',
      contractType: (emp.contractType as 'indefinite' | 'temporary' | 'freelance') || 'indefinite',
      grossSalary: formatAmountLive(emp.grossSalary || '0').displayValue,
      netSalary: formatAmountLive(emp.netSalary || '0').displayValue,
      currency: emp.currency || 'ARS',
      status: (emp.status as 'active' | 'inactive') || 'active',
      notes: emp.notes || '',
    });
    try {
      const existingAllocations = await employeeAPI.getAllocations(emp.id);
      setEditAllocations(
        (existingAllocations || []).map((a: { clientId: string; projectId?: string; projectName?: string; percentage: string; commissionRate?: string }) => ({
          clientId: a.clientId,
          projectId: a.projectId || '',
          projectName: a.projectName || '',
          percentage: a.percentage,
          commissionRate: a.commissionRate || '0',
        }))
      );
    } catch {
      setEditAllocations([]);
    }
    setEditEmployee(emp);
  };

  const onEditSubmit = (data: EmployeeFormValues) => {
    if (!editEmployee) return;
    updateMutation.mutate({
      id: editEmployee.id,
      data: {
        fullName: data.fullName,
        dni: data.dni || null,
        phone: data.phone || null,
        email: data.email || null,
        birthDate: data.birthDate || null,
        startDate: data.startDate || null,
        contractType: data.contractType,
        grossSalary: String(normalizeAmountInput(data.grossSalary || '0')),
        netSalary: String(normalizeAmountInput(data.netSalary || '0')),
        currency: data.currency,
        status: data.status,
        notes: data.notes || null,
      },
    });
  };

  const filteredEmployees = employees.filter((emp) => {
    const matchesSearch = emp.fullName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (emp.dni && emp.dni.includes(searchTerm)) ||
      (emp.email && emp.email.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesStatus = filterStatus === 'all' || emp.status === filterStatus;
    const matchesContract = filterContract === 'all' || emp.contractType === filterContract;
    return matchesSearch && matchesStatus && matchesContract;
  });

  const activeCount = employees.filter((e) => e.status === 'active').length;
  const inactiveCount = employees.filter((e) => e.status === 'inactive').length;
  const totalMonthlySalary = employees
    .filter((e) => e.status === 'active')
    .reduce((sum, e) => sum + normalizeAmountInput(e.grossSalary), 0);

  const formatCurrency = (val: number, currency: string = 'ARS') => {
    const symbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || '$';
    return `${symbol} ${val.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-lg text-muted-foreground">Cargando empleados...</div>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <BackButton />
          <h1 className="text-3xl font-bold font-display mt-2" data-testid="text-hr-title">RR.HH</h1>
          <p className="text-muted-foreground">Gestión de empleados y nómina.</p>
        </div>

        <Dialog open={isOpen} onOpenChange={(open) => { setIsOpen(open); if (!open) setCreateMaximized(false); }}>
          <DialogTrigger asChild>
            <Button className="bg-primary text-primary-foreground shadow-lg shadow-primary/20" data-testid="button-new-employee">
              <Plus className="mr-2 h-4 w-4" /> Nuevo Empleado
            </Button>
          </DialogTrigger>
          <DialogContent className={cn(
            "transition-all duration-200 overflow-y-auto",
            createMaximized
              ? "sm:max-w-[95vw] w-[95vw] h-[95vh] max-h-[95vh]"
              : "sm:max-w-[600px] w-[95vw] max-h-[90vh]"
          )}>
            {!canCreate ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="w-20 h-20 rounded-full bg-gradient-to-br from-amber-100 to-orange-100 flex items-center justify-center mb-6">
                  <ShieldAlert className="h-10 w-10 text-amber-600" />
                </div>
                <h3 className="text-xl font-bold text-gray-800 dark:text-slate-100 mb-3">Acceso restringido</h3>
                <p className="text-muted-foreground max-w-sm">No tenés permisos para crear empleados.</p>
              </div>
            ) : (
              <>
                <DialogHeader className="flex flex-row items-center justify-between pr-8">
                  <DialogTitle>Nuevo Empleado</DialogTitle>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => setCreateMaximized(!createMaximized)}
                    data-testid="button-toggle-maximize-create"
                  >
                    {createMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                  </Button>
                </DialogHeader>
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)}>
                    <EmployeeFormFields formInstance={form} />
                    <div className="mt-4">
                      <AllocationEditor value={allocations} onChange={setAllocations} clients={clients} />
                    </div>
                    <DialogFooter className="mt-6">
                      <Button type="submit" disabled={createMutation.isPending} data-testid="button-submit-employee">
                        {createMutation.isPending ? 'Creando...' : 'Crear Empleado'}
                      </Button>
                    </DialogFooter>
                  </form>
                </Form>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Card className="bg-gradient-to-br from-blue-500/10 to-blue-600/5 border-blue-500/20 overflow-hidden">
          <CardContent className="p-3">
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-lg bg-blue-500/20 flex items-center justify-center shrink-0">
                <Users className="h-4 w-4 text-blue-400" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Total</p>
                <p className="text-xl font-bold" data-testid="text-total-employees">{employees.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-green-500/10 to-green-600/5 border-green-500/20 overflow-hidden">
          <CardContent className="p-3">
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-lg bg-green-500/20 flex items-center justify-center shrink-0">
                <UserCheck className="h-4 w-4 text-green-400" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Activos</p>
                <p className="text-xl font-bold" data-testid="text-active-employees">{activeCount}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-red-500/10 to-red-600/5 border-red-500/20 overflow-hidden">
          <CardContent className="p-3">
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-lg bg-red-500/20 flex items-center justify-center shrink-0">
                <UserX className="h-4 w-4 text-red-400" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Inactivos</p>
                <p className="text-xl font-bold" data-testid="text-inactive-employees">{inactiveCount}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-cyan-500/10 to-cyan-600/5 border-cyan-500/20 overflow-hidden">
          <CardContent className="p-3">
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-lg bg-cyan-500/20 flex items-center justify-center shrink-0">
                <DollarSign className="h-4 w-4 text-cyan-400" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Masa salarial</p>
                <p className="text-sm font-bold truncate" data-testid="text-total-salary">{formatCurrency(totalMonthlySalary)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nombre, DNI o email..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
            data-testid="input-search-employees"
          />
        </div>
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-[160px]" data-testid="filter-employee-status">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            <SelectItem value="active">Activos</SelectItem>
            <SelectItem value="inactive">Inactivos</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterContract} onValueChange={setFilterContract}>
          <SelectTrigger className="w-[160px]" data-testid="filter-contract-type">
            <SelectValue placeholder="Contrato" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            {CONTRACT_TYPES.map(ct => (
              <SelectItem key={ct} value={ct}>{CONTRACT_TYPE_LABELS[ct]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead className="hidden xl:table-cell">Contacto</TableHead>
                <TableHead className="hidden lg:table-cell">Contrato</TableHead>
                <TableHead className="hidden lg:table-cell">Clientes</TableHead>
                <TableHead className="text-right">Sueldo</TableHead>
                <TableHead className="hidden sm:table-cell">Estado</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredEmployees.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    {searchTerm || filterStatus !== 'all' || filterContract !== 'all'
                      ? 'No se encontraron empleados con esos filtros.'
                      : 'No hay empleados registrados. Agregá el primero.'}
                  </TableCell>
                </TableRow>
              ) : (
                filteredEmployees.map((emp) => (
                  <TableRow
                    key={emp.id}
                    data-testid={`row-employee-${emp.id}`}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setViewEmployee(emp)}
                  >
                    <TableCell>
                      <div className="font-medium">{emp.fullName}</div>
                      {emp.dni && <div className="text-xs text-muted-foreground">DNI {emp.dni}</div>}
                      <div className="lg:hidden flex flex-wrap items-center gap-1 mt-0.5">
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                          {CONTRACT_TYPE_LABELS[emp.contractType as keyof typeof CONTRACT_TYPE_LABELS] || emp.contractType}
                        </Badge>
                        {emp.allocations && emp.allocations.length > 0 && emp.allocations.slice(0, 1).map((a, i) => (
                          <span key={i} className="text-[10px] text-muted-foreground truncate max-w-[180px]">
                            {a.clientName}{a.projectName ? ` / ${a.projectName}` : ''}
                          </span>
                        ))}
                        {emp.allocations && emp.allocations.length > 1 && (
                          <span className="text-[10px] text-muted-foreground">+{emp.allocations.length - 1}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden xl:table-cell text-sm">
                      {emp.phone && <div className="text-muted-foreground">{emp.phone}</div>}
                      {emp.email && <div className="text-muted-foreground truncate max-w-[200px]">{emp.email}</div>}
                      {!emp.phone && !emp.email && <span className="text-muted-foreground">-</span>}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <Badge variant="outline" className="text-xs">
                        {CONTRACT_TYPE_LABELS[emp.contractType as keyof typeof CONTRACT_TYPE_LABELS] || emp.contractType}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {emp.allocations && emp.allocations.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {emp.allocations.slice(0, 2).map((a, i) => (
                            <Badge key={i} variant="secondary" className="text-[10px] px-1.5 py-0" data-testid={`badge-alloc-${emp.id}-${i}`}>
                              {a.clientName}{a.projectName ? ` / ${a.projectName}` : ''} {a.percentage}%
                            </Badge>
                          ))}
                          {emp.allocations.length > 2 && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                              +{emp.allocations.length - 2}
                            </Badge>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">Sin asignar</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatCurrency(normalizeAmountInput(emp.grossSalary), emp.currency)}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Badge variant={emp.status === 'active' ? 'default' : 'secondary'} className={emp.status === 'active' ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30' : ''}>
                        {emp.status === 'active' ? 'Activo' : 'Inactivo'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={(e) => e.stopPropagation()} data-testid={`button-employee-menu-${emp.id}`}>
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setViewEmployee(emp)}>
                            <Search className="h-4 w-4 mr-2" /> Ver detalle
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleEditOpen(emp)} data-testid={`button-edit-employee-${emp.id}`}>
                            <Pencil className="h-4 w-4 mr-2" /> Editar
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-red-500"
                            onClick={() => setDeleteEmployeeId(emp.id)}
                            data-testid={`button-delete-employee-${emp.id}`}
                          >
                            <Trash2 className="h-4 w-4 mr-2" /> Eliminar
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!viewEmployee} onOpenChange={(open) => { if (!open) { setViewEmployee(null); setViewMaximized(false); } }}>
        <DialogContent className={cn(
          "transition-all duration-200 max-h-[90vh] overflow-y-auto",
          viewMaximized
            ? "sm:max-w-[95vw] sm:h-[90vh] w-full"
            : "sm:max-w-[500px] w-[95vw]"
        )}>
          {viewEmployee && (
            <>
              <DialogHeader className="flex flex-row items-center justify-between pr-8">
                <DialogTitle className="text-xl">{viewEmployee.fullName}</DialogTitle>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => setViewMaximized(!viewMaximized)}
                  data-testid="button-toggle-maximize"
                >
                  {viewMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                </Button>
              </DialogHeader>
              <div className={cn(
                "grid gap-4 py-2",
                viewMaximized && "md:grid-cols-2 md:gap-6"
              )}>
                <div className="grid gap-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">DNI / Documento</p>
                      <p className="text-sm font-medium">{viewEmployee.dni || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Estado</p>
                      <Badge variant={viewEmployee.status === 'active' ? 'default' : 'secondary'} className={viewEmployee.status === 'active' ? 'bg-green-500/20 text-green-400' : ''}>
                        {viewEmployee.status === 'active' ? 'Activo' : 'Inactivo'}
                      </Badge>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Teléfono</p>
                      <p className="text-sm font-medium">{viewEmployee.phone || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Email</p>
                      <p className="text-sm font-medium break-all">{viewEmployee.email || '-'}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Fecha de nacimiento</p>
                      <p className="text-sm font-medium">{viewEmployee.birthDate ? format(new Date(viewEmployee.birthDate), 'dd/MM/yyyy') : '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Fecha de ingreso</p>
                      <p className="text-sm font-medium">{viewEmployee.startDate ? format(new Date(viewEmployee.startDate), 'dd/MM/yyyy') : '-'}</p>
                    </div>
                  </div>
                </div>
                <div className="grid gap-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Tipo de contrato</p>
                      <p className="text-sm font-medium">{CONTRACT_TYPE_LABELS[viewEmployee.contractType as keyof typeof CONTRACT_TYPE_LABELS] || viewEmployee.contractType}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Moneda</p>
                      <p className="text-sm font-medium">{viewEmployee.currency}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Sueldo bruto</p>
                      <p className="text-lg font-bold">{formatCurrency(normalizeAmountInput(viewEmployee.grossSalary), viewEmployee.currency)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Sueldo neto</p>
                      <p className="text-lg font-bold text-muted-foreground">{formatCurrency(normalizeAmountInput(viewEmployee.netSalary), viewEmployee.currency)}</p>
                    </div>
                  </div>
                  {viewEmployee.allocations && viewEmployee.allocations.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-2">Clientes asignados</p>
                      <div className="flex flex-wrap gap-2">
                        {viewEmployee.allocations.map((a, i) => (
                          <Badge key={i} variant="secondary">
                            {a.clientName}
                            {a.projectName ? ` / ${a.projectName}` : ''}
                            {parseFloat(a.commissionRate || '0') > 0 && ` — ${a.commissionRate}% comisión`}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {viewEmployee.notes && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Notas</p>
                      <p className="text-sm">{viewEmployee.notes}</p>
                    </div>
                  )}
                </div>
              </div>
              <EmployeeProfitabilitySection employeeId={viewEmployee.id} />
              <DialogFooter>
                <Button variant="outline" onClick={() => { setViewEmployee(null); setViewMaximized(false); handleEditOpen(viewEmployee); }} data-testid="button-view-to-edit">
                  <Pencil className="h-4 w-4 mr-2" /> Editar
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!editEmployee} onOpenChange={(open) => { if (!open) { setEditEmployee(null); setEditMaximized(false); } }}>
        <DialogContent className={cn(
          "transition-all duration-200 overflow-y-auto",
          editMaximized
            ? "sm:max-w-[95vw] w-[95vw] h-[95vh] max-h-[95vh]"
            : "sm:max-w-[900px] w-[95vw] max-h-[95vh]"
        )}>
          <DialogHeader className="flex flex-row items-center justify-between pr-8">
            <DialogTitle>Editar Empleado</DialogTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setEditMaximized(!editMaximized)}
              data-testid="button-toggle-maximize-edit"
            >
              {editMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(onEditSubmit)}>
              <EmployeeFormFields formInstance={editForm} />
              <div className="mt-4">
                <AllocationEditor value={editAllocations} onChange={setEditAllocations} clients={clients} />
              </div>
              <DialogFooter className="mt-6">
                <Button type="submit" disabled={updateMutation.isPending} data-testid="button-update-employee">
                  {updateMutation.isPending ? 'Guardando...' : 'Guardar Cambios'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteEmployeeId} onOpenChange={(open) => !open && setDeleteEmployeeId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar empleado</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Estás seguro de que querés eliminar este empleado? Esta acción se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-employee">Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteEmployee} className="bg-red-500 hover:bg-red-600" data-testid="button-confirm-delete-employee">
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
