# Costos mensuales para mantener Aikestar

Precios promediados, USD/mes, sin mano de obra.

## Comparativa por escala de usuarios

| # | Concepto | 100 usuarios | 1.000 usuarios | 5.000 usuarios |
|---|---|---:|---:|---:|
| 1 | Hosting de la app | $15 | $40 | $90 |
| 2 | Base de datos PostgreSQL | $10 | $25 | $80 |
| 3 | Almacenamiento de archivos | $1 | $5 | $25 |
| 4 | Twilio WhatsApp Business | $22 | $216 | $1.082 |
| 5 | SendGrid (emails) | gratis | $20 | $90 |
| 6 | OpenAI GPT-4o-mini (chat + clasificación) | $5 | $45 | $225 |
| 7 | OpenAI GPT-4o (análisis de extractos) | $8 | $75 | $375 |
| 8 | Gemini 2.0 Flash (transcripción + clasificación liviana) | $2 | $15 | $75 |
| 9 | Dominio aikestar.net | $1 | $1 | $1 |
|   | **TOTAL infraestructura** | **$64** | **$442** | **$2.043** |

## Costos aparte (no infraestructura)

| Concepto | 100 usuarios | 1.000 usuarios | 5.000 usuarios |
|---|---:|---:|---:|
| Facturita (Tomás, estimado) | $30 | $80 | $300 |
| Sentry monitoreo (opcional) | — | $26 | $80 |
| **Total con Facturita y monitoreo** | **$94** | **$548** | **$2.423** |

**Stripe**: 3,5% del revenue + $0,30 por cobro. No es costo de infraestructura, es comisión sobre lo que cobrás.

## Costo por usuario por mes

- 100 usuarios → ~$0,94 por usuario
- 1.000 usuarios → ~$0,55 por usuario
- 5.000 usuarios → ~$0,48 por usuario

## Notas

A medida que crecés, el costo por usuario baja porque el hosting y la base de datos tienen un piso fijo. El rubro que escala casi lineal y se vuelve dominante es **WhatsApp**: a 5.000 usuarios representa más del 50% del total. Si en algún momento querés bajar costos, ese es el lugar donde más palanca hay (rate limits por tier, cuota free vs pro, etc.).
