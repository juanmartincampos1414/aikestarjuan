import {
  TERMS_INTRO,
  TERMS_LAST_UPDATED,
  TERMS_SECTIONS,
} from "@/lib/legal/terms";

export default function TermsContent() {
  return (
    <div className="space-y-6" data-testid="terms-content">
      <p className="text-sm leading-relaxed text-muted-foreground">
        {TERMS_INTRO}
      </p>

      {TERMS_SECTIONS.map((section) => (
        <div key={section.heading} className="space-y-2">
          <h3 className="font-semibold text-sm text-foreground">
            {section.heading}
          </h3>
          <ul className="space-y-1.5">
            {section.clauses.map((clause, i) => (
              <li
                key={i}
                className="text-sm leading-relaxed text-muted-foreground"
              >
                {clause}
              </li>
            ))}
          </ul>
        </div>
      ))}

      <p className="text-xs text-muted-foreground border-t pt-4">
        Última actualización: {TERMS_LAST_UPDATED}. Para consultas, contactanos a
        través del formulario de soporte.
      </p>
    </div>
  );
}
