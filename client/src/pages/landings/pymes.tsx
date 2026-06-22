import { useRef, useState, type ReactNode } from "react";
import { Volume2, VolumeX } from "lucide-react";
import logo from "@/assets/aikestar-logo.png";

const TRIAL_URL = "/register?audience=pymes";

function CTA({
  variant = "primary",
  children,
  href,
  testId,
}: {
  variant?: "primary" | "ghost";
  children: ReactNode;
  href: string;
  testId?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-xl px-7 py-4 text-base font-semibold transition-all duration-300 will-change-transform";
  const styles =
    variant === "primary"
      ? "text-primary-foreground hover:scale-[1.02] active:scale-[0.99]"
      : "border border-white/15 text-foreground hover:bg-white/5";
  return (
    <a
      href={href}
      data-testid={testId}
      className={`${base} ${styles}`}
      style={
        variant === "primary"
          ? { backgroundImage: "var(--gradient-brand)", boxShadow: "var(--shadow-glow)" }
          : undefined
      }
    >
      {children}
    </a>
  );
}

export default function PymesLanding() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    const next = !muted;
    v.muted = next;
    if (!next) {
      v.volume = 1;
      void v.play();
    }
    setMuted(next);
  };

  return (
    <main className="landing-scope min-h-screen text-foreground" style={{ background: "var(--background-deep)" }}>
      {/* HERO */}
      <section
        className="relative overflow-hidden"
        style={{ backgroundImage: "var(--gradient-radial)" }}
      >
        <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
          <div className="flex items-center gap-2">
            <img src={logo} alt="Aikestar" className="h-9 w-9" />
            <span className="text-xl font-bold tracking-tight">Aikestar</span>
          </div>
          <CTA href={TRIAL_URL} testId="cta-pymes-header">Probar gratis</CTA>
        </header>

        <div className="mx-auto grid max-w-6xl gap-12 px-6 pb-20 pt-10 md:grid-cols-2 md:items-center md:pb-28 md:pt-16">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur">
              <span className="h-2 w-2 rounded-full" style={{ background: "var(--brand-coral)" }} />
              Para PyMEs y pequeñas empresas
            </span>
            <h1 className="mt-6 text-4xl font-bold leading-[1.05] tracking-tight md:text-6xl">
              Controlá las finanzas de tu empresa{" "}
              <span
                style={{
                  backgroundImage: "var(--gradient-brand)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                en un solo lugar.
              </span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground md:text-xl">
              Ingresos, gastos y reportes con claridad. Y lo mejor:{" "}
              <span className="font-semibold text-foreground">facturá directo desde Aikestar</span> gracias a la integración automática con ARCA.
            </p>
            <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-foreground backdrop-blur">
              <span className="h-2 w-2 rounded-full" style={{ background: "var(--brand-teal)" }} />
              Facturación electrónica integrada con ARCA (ex-AFIP)
            </div>
            <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-foreground backdrop-blur">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="#25D366" aria-hidden="true">
                <path d="M20.52 3.48A11.93 11.93 0 0 0 12.05 0C5.5 0 .2 5.3.2 11.85c0 2.09.55 4.13 1.6 5.93L0 24l6.38-1.67a11.85 11.85 0 0 0 5.67 1.45h.01c6.55 0 11.85-5.3 11.85-11.85 0-3.17-1.23-6.15-3.39-8.45ZM12.06 21.5h-.01a9.65 9.65 0 0 1-4.92-1.35l-.35-.21-3.78.99 1.01-3.69-.23-.38a9.66 9.66 0 0 1-1.48-5.11c0-5.34 4.34-9.68 9.68-9.68 2.59 0 5.02 1.01 6.85 2.84a9.62 9.62 0 0 1 2.84 6.85c0 5.34-4.34 9.74-9.61 9.74Z"/>
              </svg>
              Cargá tus movimientos por WhatsApp en 1 mensaje
            </div>
            <div className="mt-8 flex flex-wrap gap-3">
              <CTA href={TRIAL_URL} testId="cta-pymes-hero">Probar gratis →</CTA>
            </div>
            <div
              className="mt-6 inline-flex items-center gap-3 rounded-2xl border p-4 backdrop-blur"
              style={{
                borderColor: "color-mix(in oklab, var(--brand-coral) 35%, transparent)",
                background: "color-mix(in oklab, var(--brand-coral) 10%, transparent)",
              }}
            >
              <span className="text-2xl" aria-hidden="true">⚡</span>
              <p className="text-sm md:text-base">
                <span className="font-semibold">Emití facturas A, B y C en segundos.</span>{" "}
                <span className="text-muted-foreground">Sin salir de Aikestar.</span>
              </p>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Planes Solo, Team y Business · Listo en minutos.
            </p>
          </div>

          <div className="relative">
            <div
              className="absolute inset-0 -z-10 blur-3xl"
              style={{ background: "var(--gradient-brand)", opacity: 0.25 }}
            />
            <video
              ref={videoRef}
              src="/game-changer.mp4"
              autoPlay
              loop
              muted
              playsInline
              className="w-full rounded-2xl border border-white/10 shadow-2xl"
            />
            <button
              type="button"
              onClick={toggleMute}
              aria-label={muted ? "Activar sonido" : "Silenciar"}
              data-testid="button-toggle-mute"
              className="absolute bottom-4 right-4 inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-black/55 text-foreground backdrop-blur transition hover:bg-black/75"
            >
              {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </section>

      {/* MULTICUENTA Y MULTIMONEDA */}
      <section className="px-6 py-20">
        <div className="mx-auto max-w-6xl">
          <div className="mx-auto max-w-2xl text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur">
              <span className="h-2 w-2 rounded-full" style={{ background: "var(--brand-teal)" }} />
              Multicuenta y Multimoneda
            </span>
            <h2 className="mt-6 text-3xl font-bold tracking-tight md:text-5xl">
              Varios negocios y tus finanzas personales,{" "}
              <span
                style={{
                  backgroundImage: "var(--gradient-brand)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                en una sola app
              </span>
              .
            </h2>
            <p className="mt-5 text-lg text-muted-foreground">
              Gestioná todas tus cuentas por separado y registrá movimientos en pesos o dólares, sin mezclar números ni perder de vista cada negocio.
            </p>
          </div>

          <div className="mt-12 grid gap-6 md:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 backdrop-blur">
              <div
                className="inline-flex h-12 w-12 items-center justify-center rounded-xl text-2xl"
                style={{
                  background: "color-mix(in oklab, var(--brand-coral) 15%, transparent)",
                  border: "1px solid color-mix(in oklab, var(--brand-coral) 35%, transparent)",
                }}
                aria-hidden="true"
              >
                🏢
              </div>
              <h3 className="mt-5 text-xl font-semibold">Multicuenta</h3>
              <p className="mt-3 text-muted-foreground">
                Manejá varios negocios y tus finanzas personales por separado, con reportes independientes para cada uno. Cambiá entre cuentas en un clic.
              </p>
              <ul className="mt-5 space-y-2 text-sm text-muted-foreground">
                <li className="flex items-start gap-2"><span style={{ color: "var(--brand-teal)" }}>✓</span> Negocios y finanzas personales separados</li>
                <li className="flex items-start gap-2"><span style={{ color: "var(--brand-teal)" }}>✓</span> Reportes individuales por cuenta</li>
                <li className="flex items-start gap-2"><span style={{ color: "var(--brand-teal)" }}>✓</span> Cambio rápido entre cuentas</li>
              </ul>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 backdrop-blur">
              <div
                className="inline-flex h-12 w-12 items-center justify-center rounded-xl text-2xl"
                style={{
                  background: "color-mix(in oklab, var(--brand-teal) 15%, transparent)",
                  border: "1px solid color-mix(in oklab, var(--brand-teal) 35%, transparent)",
                }}
                aria-hidden="true"
              >
                💱
              </div>
              <h3 className="mt-5 text-xl font-semibold">Multimoneda</h3>
              <p className="mt-3 text-muted-foreground">
                Cargá transacciones en pesos o dólares según corresponda. Cada movimiento se registra en su moneda original, sin conversiones forzadas.
              </p>
              <ul className="mt-5 space-y-2 text-sm text-muted-foreground">
                <li className="flex items-start gap-2"><span style={{ color: "var(--brand-teal)" }}>✓</span> Pesos (ARS) y dólares (USD)</li>
                <li className="flex items-start gap-2"><span style={{ color: "var(--brand-teal)" }}>✓</span> Saldos claros en cada moneda</li>
                <li className="flex items-start gap-2"><span style={{ color: "var(--brand-teal)" }}>✓</span> Reportes diferenciados por divisa</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="px-6 pb-20 pt-4">
        <div
          className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl border border-white/10 p-10 text-center md:p-16"
          style={{ background: "var(--background)" }}
        >
          <div
            className="absolute inset-x-0 top-0 h-1"
            style={{ background: "var(--gradient-brand)" }}
          />
          <h2 className="text-3xl font-bold tracking-tight md:text-5xl">
            Tu empresa, finalmente{" "}
            <span
              style={{
                backgroundImage: "var(--gradient-brand)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              bajo control
            </span>
            .
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg text-muted-foreground">
            Centralizá ingresos, gastos y facturación electrónica con ARCA. Decidí con datos reales, no con planillas sueltas.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <CTA href={TRIAL_URL} testId="cta-pymes-final">Probar gratis →</CTA>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Pensado para PyMEs · Cancelás cuando quieras
          </p>
        </div>
      </section>

      <footer className="border-t border-white/5 py-6 text-center text-sm text-muted-foreground">
        <div>© {new Date().getFullYear()} Aikestar</div>
        <div className="mt-2 flex items-center justify-center gap-4">
          <a
            href="/terminos"
            className="inline-block underline hover:text-foreground transition-colors"
            data-testid="link-terminos"
          >
            Términos y Condiciones
          </a>
          <a
            href="/privacidad"
            className="inline-block underline hover:text-foreground transition-colors"
            data-testid="link-privacidad"
          >
            Política de Privacidad
          </a>
        </div>
      </footer>
    </main>
  );
}
