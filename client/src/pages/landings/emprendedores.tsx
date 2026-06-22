import { useRef, useState, type ReactNode } from "react";
import logo from "@/assets/aikestar-logo.png";

const TRIAL_URL = "/register?audience=emprendedores";

function HeroVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);

  const toggle = () => {
    const v = ref.current;
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
    <div className="relative">
      <div
        className="absolute inset-0 -z-10 blur-3xl"
        style={{ background: "var(--gradient-brand)", opacity: 0.25 }}
      />
      <video
        ref={ref}
        src="/game-changer.mp4"
        autoPlay
        loop
        muted
        playsInline
        className="w-full rounded-2xl border border-white/10 shadow-2xl"
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={muted ? "Activar sonido" : "Silenciar"}
        data-testid="button-toggle-mute"
        className="absolute bottom-4 right-4 inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white backdrop-blur transition hover:bg-black/80"
      >
        {muted ? (
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M11 5 6 9H2v6h4l5 4V5z" />
            <line x1="22" y1="9" x2="16" y2="15" />
            <line x1="16" y1="9" x2="22" y2="15" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M11 5 6 9H2v6h4l5 4V5z" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </svg>
        )}
      </button>
    </div>
  );
}

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

export default function EmprendedoresLanding() {
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
          <CTA href={TRIAL_URL} testId="cta-emprendedores-header">Empezar gratis</CTA>
        </header>

        <div className="mx-auto grid max-w-6xl gap-12 px-6 pb-20 pt-10 md:grid-cols-2 md:items-center md:pb-28 md:pt-16">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur">
              <span className="h-2 w-2 rounded-full" style={{ background: "var(--brand-coral)" }} />
              Para freelancers, monotributistas y pequeños negocios
            </span>
            <h1 className="mt-6 text-4xl font-bold leading-[1.05] tracking-tight md:text-6xl">
              Ordená las finanzas de tu negocio{" "}
              <span
                style={{
                  backgroundImage: "var(--gradient-brand)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                sin depender de Excel.
              </span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground md:text-xl">
              Registrá ingresos y gastos en segundos —{" "}
              <span className="font-semibold text-foreground">incluso por WhatsApp</span>. Mirá cuánto ganás de verdad y tomá mejores decisiones para hacer crecer tu emprendimiento.
            </p>
            <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-foreground backdrop-blur">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="#25D366" aria-hidden="true">
                <path d="M20.52 3.48A11.93 11.93 0 0 0 12.05 0C5.5 0 .2 5.3.2 11.85c0 2.09.55 4.13 1.6 5.93L0 24l6.38-1.67a11.85 11.85 0 0 0 5.67 1.45h.01c6.55 0 11.85-5.3 11.85-11.85 0-3.17-1.23-6.15-3.39-8.45ZM12.06 21.5h-.01a9.65 9.65 0 0 1-4.92-1.35l-.35-.21-3.78.99 1.01-3.69-.23-.38a9.66 9.66 0 0 1-1.48-5.11c0-5.34 4.34-9.68 9.68-9.68 2.59 0 5.02 1.01 6.85 2.84a9.62 9.62 0 0 1 2.84 6.85c0 5.34-4.34 9.74-9.61 9.74Z"/>
              </svg>
              Cargá tus movimientos por WhatsApp en 1 mensaje
            </div>
            <div className="mt-8 flex flex-wrap gap-3">
              <CTA href={TRIAL_URL} testId="cta-emprendedores-hero">Empezar gratis →</CTA>
            </div>
            <div
              className="mt-6 inline-flex items-center gap-3 rounded-2xl border p-4 backdrop-blur"
              style={{
                borderColor: "color-mix(in oklab, var(--brand-coral) 35%, transparent)",
                background: "color-mix(in oklab, var(--brand-coral) 10%, transparent)",
              }}
            >
              <span className="text-2xl" aria-hidden="true">☕</span>
              <p className="text-sm md:text-base">
                <span className="font-semibold">Sale lo mismo que un café.</span>{" "}
                <span className="text-muted-foreground">Y te ordena todo el negocio.</span>
              </p>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Sin instalaciones. Listo en 5 minutos.
            </p>
          </div>

          <HeroVideo />
        </div>
      </section>

      {/* FEATURES */}
      <section className="px-6 py-16 md:py-24">
        <div className="mx-auto max-w-6xl">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
              Un solo lugar para{" "}
              <span
                style={{
                  backgroundImage: "var(--gradient-brand)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                todas tus cuentas
              </span>
              .
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              Manejá distintos negocios y tus finanzas personales desde la misma cuenta. Y cargá transacciones en pesos o dólares, como las hagas.
            </p>
          </div>

          <div className="mt-12 grid gap-5 md:grid-cols-2">
            <div
              className="rounded-2xl border border-white/10 p-6 backdrop-blur"
              style={{ background: "color-mix(in oklab, var(--brand-blue) 8%, transparent)" }}
            >
              <div
                className="inline-flex h-11 w-11 items-center justify-center rounded-xl"
                style={{ background: "color-mix(in oklab, var(--brand-blue) 25%, transparent)" }}
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="7" width="18" height="13" rx="2" />
                  <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
                  <path d="M3 12h18" />
                </svg>
              </div>
              <h3 className="mt-4 text-xl font-semibold">Multicuenta</h3>
              <p className="mt-2 text-muted-foreground">
                Llevá la contabilidad de cada negocio por separado y sumá tus finanzas personales en la misma plataforma. Sin mezclar números, sin planillas paralelas.
              </p>
            </div>

            <div
              className="rounded-2xl border border-white/10 p-6 backdrop-blur"
              style={{ background: "color-mix(in oklab, var(--brand-coral) 8%, transparent)" }}
            >
              <div
                className="inline-flex h-11 w-11 items-center justify-center rounded-xl"
                style={{ background: "color-mix(in oklab, var(--brand-coral) 25%, transparent)" }}
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 6v12" />
                  <path d="M15 9.5c0-1.4-1.3-2.5-3-2.5s-3 1.1-3 2.5 1.3 2.5 3 2.5 3 1.1 3 2.5-1.3 2.5-3 2.5-3-1.1-3-2.5" />
                </svg>
              </div>
              <h3 className="mt-4 text-xl font-semibold">Multimoneda</h3>
              <p className="mt-2 text-muted-foreground">
                Cargá ingresos y gastos en pesos o en dólares. Aikestar te muestra todo unificado para que veas la foto real de tu negocio.
              </p>
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
            Empezá a llevar tu negocio{" "}
            <span
              style={{
                backgroundImage: "var(--gradient-brand)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              en orden
            </span>
            .
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg text-muted-foreground">
            Probalo gratis hoy y empezá a tomar decisiones con datos reales, no con intuición.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <CTA href={TRIAL_URL} testId="cta-emprendedores-final">Empezar gratis →</CTA>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Pensado para emprendedores · Cancelás cuando quieras
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
