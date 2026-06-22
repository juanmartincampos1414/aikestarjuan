import { useTheme } from 'next-themes';
import { Sun, Moon, Monitor, Check } from 'lucide-react';
import {
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuItem,
  DropdownMenuPortal,
} from '@/components/ui/dropdown-menu';

const OPTIONS: { value: 'light' | 'dark' | 'system'; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Claro', Icon: Sun },
  { value: 'dark', label: 'Oscuro', Icon: Moon },
  { value: 'system', label: 'Automático', Icon: Monitor },
];

export function ThemeToggleMenu() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const current = (theme as 'light' | 'dark' | 'system' | undefined) || 'system';
  const TriggerIcon =
    current === 'system'
      ? Monitor
      : (resolvedTheme === 'dark' ? Moon : Sun);

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className="cursor-pointer"
        data-testid="menu-theme-toggle"
      >
        <TriggerIcon className="h-4 w-4 mr-2" />
        Apariencia
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-44">
          {OPTIONS.map(({ value, label, Icon }) => (
            <DropdownMenuItem
              key={value}
              className="cursor-pointer flex items-center"
              onClick={() => setTheme(value)}
              data-testid={`menu-theme-${value}`}
            >
              <Icon className="h-4 w-4 mr-2" />
              <span className="flex-1">{label}</span>
              {current === value && <Check className="h-4 w-4 text-primary" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}
