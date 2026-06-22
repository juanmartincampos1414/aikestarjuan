import { Lock, Database, Eye, FileText, Check } from "lucide-react";

export const PRIVACY_TITLE = "Políticas de Privacidad";

export default function PrivacyContent() {
  return (
    <div className="space-y-6 pt-2" data-testid="privacy-content">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex items-start gap-3 p-4 rounded-lg bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/20">
          <Lock className="h-5 w-5 text-green-600 dark:text-green-400 mt-0.5 flex-shrink-0" />
          <div>
            <h4 className="font-medium text-green-900 dark:text-green-100">Cifrado de Datos</h4>
            <p className="text-sm text-green-700 dark:text-green-300 mt-1">
              Toda tu información financiera está cifrada con AES-256, el estándar de seguridad utilizado por bancos.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 p-4 rounded-lg bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20">
          <Database className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
          <div>
            <h4 className="font-medium text-blue-900 dark:text-blue-100">Almacenamiento Seguro</h4>
            <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
              Tus datos se almacenan en servidores certificados con respaldos automáticos diarios.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 p-4 rounded-lg bg-purple-50 dark:bg-purple-500/10 border border-purple-200 dark:border-purple-500/20">
          <Eye className="h-5 w-5 text-purple-600 dark:text-purple-400 mt-0.5 flex-shrink-0" />
          <div>
            <h4 className="font-medium text-purple-900 dark:text-purple-100">Privacidad Total</h4>
            <p className="text-sm text-purple-700 dark:text-purple-300 mt-1">
              Nunca compartimos, vendemos o analizamos tu información con terceros sin tu consentimiento.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 p-4 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20">
          <FileText className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
          <div>
            <h4 className="font-medium text-amber-900 dark:text-amber-100">Cumplimiento Legal</h4>
            <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
              Cumplimos con las normativas de protección de datos personales vigentes en Argentina.
            </p>
          </div>
        </div>
      </div>

      <div className="border-t pt-4">
        <h4 className="font-medium mb-3">Tus Derechos</h4>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-center gap-2">
            <Check className="h-4 w-4 text-green-500" />
            Acceder a todos tus datos almacenados en cualquier momento
          </li>
          <li className="flex items-center gap-2">
            <Check className="h-4 w-4 text-green-500" />
            Solicitar la eliminación completa de tu cuenta y datos
          </li>
          <li className="flex items-center gap-2">
            <Check className="h-4 w-4 text-green-500" />
            Exportar toda tu información en formato CSV o PDF
          </li>
          <li className="flex items-center gap-2">
            <Check className="h-4 w-4 text-green-500" />
            Modificar o corregir cualquier información personal
          </li>
        </ul>
      </div>

      <p className="text-xs text-muted-foreground border-t pt-4">
        Última actualización: Enero 2026. Para consultas sobre privacidad, contactanos a través del formulario de soporte.
      </p>
    </div>
  );
}
