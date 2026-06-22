import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { LucideIcon } from "lucide-react";
import React from "react";

interface StatCardProps {
  title: string;
  value: React.ReactNode;
  description?: string;
  icon?: LucideIcon;
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
  trendColor?: 'positive' | 'negative';
  className?: string;
  onClick?: () => void;
}

export function StatCard({ 
  title, 
  value, 
  description, 
  icon: Icon, 
  trend,
  trendValue,
  trendColor,
  className,
  onClick,
}: StatCardProps) {
  const effectiveColor = trendColor 
    ? trendColor 
    : (trend === 'up' ? 'positive' : trend === 'down' ? 'negative' : undefined);
  return (
    <Card 
      className={cn(
        "overflow-hidden border border-primary/10 bg-card/95 backdrop-blur-sm",
        "shadow-lg shadow-primary/5 hover:shadow-xl hover:shadow-primary/10",
        "transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5",
        onClick && "cursor-pointer hover:ring-2 hover:ring-primary/20",
        className
      )}
      onClick={onClick}
      data-testid={onClick ? `stat-card-${title.toLowerCase().replace(/\s+/g, '-').replace(/[()]/g, '')}` : undefined}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1 sm:pb-2 px-3 sm:px-6 pt-3 sm:pt-6">
        <CardTitle className="text-xs sm:text-sm font-medium text-muted-foreground truncate mr-2">
          {title}
        </CardTitle>
        {Icon && (
          <div className="p-1.5 sm:p-2 rounded-xl bg-gradient-to-br from-primary/15 to-primary/5 shadow-sm flex-shrink-0">
            <Icon className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-primary" />
          </div>
        )}
      </CardHeader>
      <CardContent className="px-3 sm:px-6 pb-3 sm:pb-6">
        <div 
          className={cn(
            "font-bold font-display tracking-tight text-foreground leading-tight tabular-nums break-words overflow-hidden",
            onClick && "pointer-events-none"
          )}
          style={{ fontSize: 'clamp(0.85rem, 3vw, 1.5rem)' }}
        >
          {value}
        </div>
        {(description || trendValue) && (
          <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
            {trend && (
              <span className={cn(
                "font-medium px-1.5 py-0.5 rounded",
                effectiveColor === 'positive' && "text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-500/15",
                effectiveColor === 'negative' && "text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-500/15"
              )}>
                {trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'} {trendValue}
              </span>
            )}
            <span className="opacity-80">{description}</span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
