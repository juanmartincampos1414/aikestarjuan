import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';

interface BackButtonProps {
  fallbackPath?: string;
}

export function BackButton({ fallbackPath = '/' }: BackButtonProps) {
  const [, setLocation] = useLocation();

  const handleBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      setLocation(fallbackPath);
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleBack}
      className="gap-2 text-muted-foreground hover:text-foreground"
      data-testid="button-back"
    >
      <ArrowLeft className="h-4 w-4" />
      Volver
    </Button>
  );
}
