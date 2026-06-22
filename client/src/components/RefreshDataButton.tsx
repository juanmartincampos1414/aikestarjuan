import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

export function RefreshDataButton() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await queryClient.invalidateQueries({ refetchType: 'all' });
      toast({
        title: 'Datos actualizados',
        description: 'Se refrescó toda la información visible.',
        duration: 3000,
      });
    } catch {
      toast({
        title: 'No se pudo actualizar',
        description: 'Ocurrió un error al refrescar los datos. Probá de nuevo.',
        variant: 'destructive',
        duration: 5000,
      });
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleRefresh}
      disabled={isRefreshing}
      aria-label={isRefreshing ? 'Actualizando datos' : 'Actualizar datos'}
      aria-busy={isRefreshing}
      className="relative h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
      title={isRefreshing ? 'Actualizando…' : 'Actualizar datos'}
      data-testid="button-refresh-data"
    >
      <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
    </Button>
  );
}

export default RefreshDataButton;
