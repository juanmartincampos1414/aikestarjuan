// =============================================================================
// AIKESTAR - Widget embebible de TradingView (cotizaciones en vivo)
// =============================================================================
// Inyecta el script oficial de embedding de TradingView. Sin API key.
// Tipos usados: 'ticker-tape' (cinta superior) y 'advanced-chart' (gráfico).
// =============================================================================
import { useEffect, useRef } from 'react';

type WidgetType = 'ticker-tape' | 'advanced-chart' | 'symbol-overview';

const SCRIPT_SRC: Record<WidgetType, string> = {
  'ticker-tape': 'https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js',
  'advanced-chart': 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js',
  'symbol-overview': 'https://s3.tradingview.com/external-embedding/embed-widget-symbol-overview.js',
};

export function TradingViewWidget({ type, config, height }: { type: WidgetType; config: Record<string, any>; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const configKey = JSON.stringify(config);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = '';
    const widgetEl = document.createElement('div');
    widgetEl.className = 'tradingview-widget-container__widget';
    container.appendChild(widgetEl);
    const script = document.createElement('script');
    script.src = SCRIPT_SRC[type];
    script.type = 'text/javascript';
    script.async = true;
    script.innerHTML = JSON.stringify(config);
    container.appendChild(script);
    return () => { container.innerHTML = ''; };
  }, [type, configKey]);

  return (
    <div className="tradingview-widget-container" ref={containerRef} style={height ? { height } : undefined} />
  );
}
