// =============================================================================
// AIKESTAR - Cliente Claude (Anthropic) con interfaz compatible OpenAI
// =============================================================================
// Toda la IA de texto/visión de la app pasa por acá. En vez de reescribir las
// decenas de llamadas `openai.chat.completions.create({...})` repartidas por el
// código, este módulo expone un objeto con la MISMA forma que el cliente de
// OpenAI pero que por debajo usa el SDK oficial de Anthropic (`@anthropic-ai/sdk`)
// y el modelo Claude Opus 4.8 (`claude-opus-4-8`).
//
// Mapea:
//   - messages con roles system/user/assistant
//   - contenido string o array con bloques { type:'text' } y
//     { type:'image_url', image_url:{ url:'data:<mime>;base64,<data>' } } → bloques de imagen de Claude
//   - response_format:{ type:'json_object' } → instrucción de "responde solo JSON"
//   - max_tokens (se respeta; temperature se ignora: Opus 4.8 no la acepta)
// Devuelve la forma que el resto del código espera: { choices:[{ message:{ content } }] }.
// =============================================================================
import Anthropic from "@anthropic-ai/sdk";

// Modelo Claude por defecto para toda la app.
export const CLAUDE_MODEL = "claude-opus-4-8";

// Cliente Anthropic compartido. Lee la API key de ANTHROPIC_API_KEY.
// No se rompe si falta la key al construir; sólo fallará en la llamada real
// (igual que el comportamiento previo, donde la IA degradaba con try/catch).
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Tipos de la interfaz compatible OpenAI que usamos en la app ──────────────
type OAITextPart = { type: "text"; text: string };
type OAIImagePart = {
  type: "image_url";
  image_url: { url: string; detail?: string };
};
type OAIContentPart = OAITextPart | OAIImagePart;
type OAIMessage = {
  role: "system" | "user" | "assistant";
  content: string | OAIContentPart[];
};
interface OAIChatParams {
  model?: string;
  messages: OAIMessage[];
  max_tokens?: number;
  temperature?: number; // ignorado en Claude Opus 4.8
  response_format?: { type?: string };
  [key: string]: any;
}

// Convierte una data-URL base64 ("data:image/png;base64,AAAA") en el bloque de
// imagen que espera la API de Claude. Devuelve null si el formato no es válido.
function dataUrlToClaudeImage(url: string): Anthropic.ImageBlockParam | null {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (!match) return null;
  const mediaType = match[1] as Anthropic.Base64ImageSource["media_type"];
  const data = match[2];
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data },
  };
}

// Convierte el contenido de un mensaje OpenAI a bloques de contenido de Claude.
function toClaudeContent(
  content: string | OAIContentPart[],
): string | Anthropic.ContentBlockParam[] {
  if (typeof content === "string") return content;
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      const img = dataUrlToClaudeImage(part.image_url.url);
      if (img) blocks.push(img);
      // Las URLs http(s) directas también son soportadas por Claude:
      else if (/^https?:\/\//.test(part.image_url.url)) {
        blocks.push({
          type: "image",
          source: { type: "url", url: part.image_url.url },
        });
      }
    }
  }
  return blocks.length > 0 ? blocks : "";
}

// Núcleo: traduce una llamada estilo OpenAI a una llamada a Claude.
async function createChatCompletion(params: OAIChatParams) {
  // 1) Separar los mensajes de sistema (Claude los lleva en `system`, aparte).
  const systemParts: string[] = [];
  const claudeMessages: Anthropic.MessageParam[] = [];

  for (const msg of params.messages) {
    if (msg.role === "system") {
      systemParts.push(
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((p): p is OAITextPart => p.type === "text")
              .map((p) => p.text)
              .join("\n"),
      );
      continue;
    }
    claudeMessages.push({
      role: msg.role, // 'user' | 'assistant'
      content: toClaudeContent(msg.content),
    });
  }

  // 2) Modo JSON: reforzar en el system que responda sólo con JSON válido.
  if (params.response_format?.type === "json_object") {
    systemParts.push(
      "IMPORTANTE: Respondé ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin explicaciones y sin bloques de código markdown.",
    );
  }

  const system = systemParts.join("\n\n").trim();

  // 3) Modelo: si llega un id de OpenAI (gpt-*) u otro, usamos Claude igual.
  const model =
    typeof params.model === "string" && params.model.startsWith("claude")
      ? params.model
      : CLAUDE_MODEL;

  // 4) Llamada a Claude. No mandamos temperature (Opus 4.8 la rechaza).
  const response = await anthropic.messages.create({
    model,
    max_tokens: params.max_tokens ?? 1024,
    ...(system ? { system } : {}),
    messages: claudeMessages,
  });

  // 5) Concatenar los bloques de texto de la respuesta.
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  // 6) Devolver la forma que espera el resto del código (estilo OpenAI).
  return {
    id: response.id,
    model: response.model,
    choices: [
      {
        index: 0,
        finish_reason: response.stop_reason ?? "stop",
        message: { role: "assistant" as const, content: text },
      },
    ],
    usage: {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens:
        response.usage.input_tokens + response.usage.output_tokens,
    },
  };
}

// Objeto con la misma superficie que usamos del cliente OpenAI.
export interface ClaudeOpenAICompatClient {
  chat: { completions: { create: typeof createChatCompletion } };
}

function buildClient(): ClaudeOpenAICompatClient {
  return { chat: { completions: { create: createChatCompletion } } };
}

// Export default: clase que se instancia con `new OpenAI({...})` (se ignoran
// apiKey/baseURL del llamador; usamos ANTHROPIC_API_KEY del entorno) y devuelve
// el cliente compatible. Así los call-sites existentes cambian sólo el import.
export default class ClaudeOpenAI {
  chat: ClaudeOpenAICompatClient["chat"];
  constructor(_opts?: { apiKey?: string; baseURL?: string }) {
    this.chat = buildClient().chat;
  }
}

// Acceso directo al cliente Anthropic por si se necesita en el futuro.
export { anthropic };
