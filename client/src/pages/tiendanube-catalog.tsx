// =============================================================================
// AIKESTAR - Catálogo de Tiendanube (Oficina → Tiendanube)
// Lista todos los productos sincronizados desde Tiendanube con stock, precio, etc.
// =============================================================================
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { fetchWithAuth } from '@/lib/api';
import { formatCurrencyAR } from '@/lib/currency';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, Store, Search, AlertTriangle, RefreshCw, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { useState } from 'react';
import type { Product } from '@shared/schema';

type SortKey = 'name' | 'salePrice' | 'stock';
type SortDir = 'asc' | 'desc';

export default function TiendanubeCatalogPage() {
  const [q, setQ] = useState('');
  const [onlyLow, setOnlyLow] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'name' ? 'asc' : 'desc'); }
  }
  function isLow(p: any) {
    const min = parseFloat(p.minStock ?? '0') || 0;
    return min > 0 && (parseFloat(p.stock) || 0) <= min;
  }

  const { data: allProducts = [], isLoading } = useQuery<Product[]>({
    queryKey: ['/api/products', 'tiendanube-catalog'],
    queryFn: () => fetchWithAuth('/products'),
  });

  const { data: status } = useQuery<any>({
    queryKey: ['/tiendanube/status'],
    queryFn: () => fetchWithAuth('/tiendanube/status'),
    retry: false,
  });

  const products = useMemo(
    () => (allProducts || []).filter((p: any) => p.externalSource === 'tiendanube'),
    [allProducts],
  );

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    let list = products.filter((p: any) => {
      const matchesTerm = !term || (p.name || '').toLowerCase().includes(term) || (p.sku || '').toLowerCase().includes(term);
      return matchesTerm && (!onlyLow || isLow(p));
    });
    const dir = sortDir === 'asc' ? 1 : -1;
    list = [...list].sort((a: any, b: any) => {
      if (sortKey === 'name') return dir * String(a.name || '').localeCompare(String(b.name || ''), 'es');
      const av = parseFloat(a[sortKey]) || 0;
      const bv = parseFloat(b[sortKey]) || 0;
      return dir * (av - bv);
    });
    return list;
  }, [products, q, onlyLow, sortKey, sortDir]);

  const totalStock = useMemo(
    () => products.reduce((acc: number, p: any) => acc + (parseFloat(p.stock) || 0), 0),
    [products],
  );
  const lowStock = useMemo(
    () => products.filter((p: any) => parseFloat(p.stock) <= parseFloat(p.minStock ?? '0') && parseFloat(p.minStock ?? '0') > 0).length,
    [products],
  );

  if (isLoading) {
    return <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Store className="h-6 w-6 text-[#00C3DD]" /> Catálogo Tiendanube
          </h1>
          <p className="text-sm text-muted-foreground">Productos sincronizados desde tu tienda online.</p>
        </div>
        <Link href="/settings?tab=integrations">
          <Button variant="outline" size="sm"><RefreshCw className="h-4 w-4 mr-1" /> Sincronizar / Configurar</Button>
        </Link>
      </div>

      {/* Resumen */}
      <div className="grid grid-cols-3 gap-3">
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Productos</div><div className="text-2xl font-bold">{products.length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Stock total (u.)</div><div className="text-2xl font-bold">{totalStock.toLocaleString('es-AR')}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Stock bajo</div><div className={`text-2xl font-bold ${lowStock > 0 ? 'text-orange-600' : ''}`}>{lowStock}</div></CardContent></Card>
      </div>

      {products.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-3">
            <Store className="h-10 w-10 mx-auto text-muted-foreground" />
            <p className="font-medium">Todavía no hay productos de Tiendanube</p>
            <p className="text-sm text-muted-foreground">
              {status?.connection
                ? 'Conectaste tu tienda pero no sincronizaste el catálogo todavía.'
                : 'Conectá tu tienda Tiendanube para traer tu catálogo automáticamente.'}
            </p>
            <Link href="/settings?tab=integrations">
              <Button className="bg-gradient-to-r from-[#00D4FF] to-[#FF3366]">
                {status?.connection ? 'Sincronizar catálogo' : 'Conectar Tiendanube'}
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="p-3 border-b flex flex-wrap items-center gap-2 justify-between">
              <div className="relative max-w-xs flex-1 min-w-[200px]">
                <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input placeholder="Buscar por nombre o SKU…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
              </div>
              <Button
                variant={onlyLow ? 'default' : 'outline'}
                size="sm"
                onClick={() => setOnlyLow((v) => !v)}
                className={onlyLow ? 'bg-orange-500 hover:bg-orange-600' : ''}
              >
                <AlertTriangle className="h-4 w-4 mr-1" /> Solo stock bajo
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground border-b select-none">
                  <tr>
                    <SortHeader label="Producto" col="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <th className="px-4 py-2 font-medium">SKU</th>
                    <SortHeader label="Precio" col="salePrice" align="right" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <SortHeader label="Stock" col="stock" align="right" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <th className="px-4 py-2 font-medium">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p: any) => {
                    const stock = parseFloat(p.stock) || 0;
                    const min = parseFloat(p.minStock ?? '0') || 0;
                    const low = min > 0 && stock <= min;
                    return (
                      <tr key={p.id} className="border-b last:border-0 hover:bg-muted/40">
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-3">
                            {p.imageUrl ? (
                              <img
                                src={p.imageUrl}
                                alt={p.name}
                                loading="lazy"
                                className="h-10 w-10 rounded-md object-cover border bg-muted shrink-0"
                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                              />
                            ) : (
                              <div className="h-10 w-10 rounded-md border bg-muted flex items-center justify-center shrink-0">
                                <Store className="h-4 w-4 text-muted-foreground" />
                              </div>
                            )}
                            <div>
                              <Link href="/products">
                                <span className="font-medium hover:text-[#00C3DD] hover:underline cursor-pointer">{p.name}</span>
                              </Link>
                              {p.barcode && <div className="text-xs text-muted-foreground">Cód: {p.barcode}</div>}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{p.sku || '—'}</td>
                        <td className="px-4 py-2.5 text-right font-medium">{formatCurrencyAR(p.salePrice ?? '0', 'ARS')}</td>
                        <td className={`px-4 py-2.5 text-right font-medium ${low ? 'text-orange-600' : ''}`}>
                          {stock.toLocaleString('es-AR')}
                          {low && <AlertTriangle className="h-3.5 w-3.5 inline ml-1 -mt-0.5" />}
                        </td>
                        <td className="px-4 py-2.5">
                          {p.isActive
                            ? <Badge variant="outline" className="text-emerald-600 border-emerald-300 bg-emerald-50">Activo</Badge>
                            : <Badge variant="outline" className="text-muted-foreground">Inactivo</Badge>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Encabezado de columna ordenable.
function SortHeader({ label, col, align = 'left', sortKey, sortDir, onSort }: {
  label: string; col: SortKey; align?: 'left' | 'right';
  sortKey: SortKey; sortDir: SortDir; onSort: (c: SortKey) => void;
}) {
  const active = sortKey === col;
  return (
    <th className={`px-4 py-2 font-medium ${align === 'right' ? 'text-right' : ''}`}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${align === 'right' ? 'flex-row-reverse' : ''} ${active ? 'text-foreground' : ''}`}
      >
        {label}
        {active
          ? (sortDir === 'asc' ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />)
          : <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />}
      </button>
    </th>
  );
}
