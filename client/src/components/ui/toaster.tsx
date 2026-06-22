import { useToast } from "@/hooks/use-toast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"
import { MessageCircle } from "lucide-react"

const WHATSAPP_NUMBER = "5491153874843";

function buildWhatsAppUrl(errorMsg?: string) {
  const text = errorMsg
    ? `Hola, me apareció este error en Aikestar: "${errorMsg}"`
    : "Hola, tuve un error en Aikestar y necesito ayuda.";
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
}

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, variant, ...props }) {
        const isDestructive = variant === "destructive";
        const errorText = typeof description === "string" ? description : typeof title === "string" ? title : undefined;

        return (
          <Toast key={id} variant={variant} {...props}>
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
              {isDestructive && (
                <a
                  href={buildWhatsAppUrl(errorText)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 mt-2 px-3 py-1 rounded bg-[#25D366] text-white text-xs font-medium hover:bg-[#1da851] transition-colors w-fit"
                  data-testid="link-whatsapp-error"
                >
                  <MessageCircle className="h-3.5 w-3.5" />
                  Avisanos por WhatsApp
                </a>
              )}
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
