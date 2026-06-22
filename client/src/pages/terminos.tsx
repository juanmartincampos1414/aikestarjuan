import { ArrowLeft } from "lucide-react";
import TermsContent from "@/components/TermsContent";
import { TERMS_TITLE } from "@/lib/legal/terms";
import logo from "@/assets/aikestar-logo.png";

export default function TerminosPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-white/5">
        <div className="max-w-3xl mx-auto px-6 py-5 flex items-center justify-between gap-4">
          <a
            href="/"
            className="flex items-center gap-2"
            data-testid="link-home"
          >
            <img src={logo} alt="Aikestar" className="h-8 w-auto" />
          </a>
          <a
            href="/"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            data-testid="link-back"
          >
            <ArrowLeft className="h-4 w-4" />
            Volver
          </a>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10">
        <h1
          className="text-2xl font-bold mb-8"
          data-testid="text-terms-title"
        >
          {TERMS_TITLE}
        </h1>
        <TermsContent />
      </main>

      <footer className="border-t border-white/5 py-6 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} Aikestar
      </footer>
    </div>
  );
}
