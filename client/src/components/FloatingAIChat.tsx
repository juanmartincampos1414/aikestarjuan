import React, { useState, useEffect, useRef } from 'react';
import { useOrganization } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sparkles, Loader2, Send, X, Maximize2, PanelRightClose, Minus, Building2, Mic, MicOff, RotateCcw, Image as ImageIcon, Upload, HelpCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { getIconByKey } from '@/components/OrganizationBrandPicker';
import aikeLogo from '@/assets/aike-logo.png';
import { fetchWithAuth } from '@/lib/api';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

type ChatMode = 'hidden' | 'panel' | 'fullscreen';

const HELP_SUGGESTIONS = [
  { label: 'Como funciona la CC?', icon: '📒' },
  { label: 'Guiame para crear una cuenta', icon: '🏦' },
  { label: 'Que informes tengo?', icon: '📊' },
  { label: 'Como registro un movimiento?', icon: '💰' },
  { label: 'Como invito a mi equipo?', icon: '👥' },
  { label: 'Cual es mi salud financiera?', icon: '❤️' },
];

export default function FloatingAIChat() {
  const { data: organization } = useOrganization();
  const { toast } = useToast();
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  const [mode, setMode] = useState<ChatMode>('hidden');
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isAnalyzingImage, setIsAnalyzingImage] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previousOrgIdRef = useRef<string | undefined>(undefined);
  const voiceTranscriptRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
    return () => clearTimeout(timer);
  }, [messages, isLoading]);

  useEffect(() => {
    if (mode !== 'hidden') {
      const timer = setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [mode]);

  useEffect(() => {
    if (previousOrgIdRef.current === undefined && organization?.id) {
      loadChatHistory();
    } else if (previousOrgIdRef.current !== undefined && previousOrgIdRef.current !== organization?.id) {
      loadChatHistory();
    }
    previousOrgIdRef.current = organization?.id;
  }, [organization?.id]);

  const loadChatHistory = async () => {
    setMessages([]);
    setInput('');
    
    try {
      const data = await fetchWithAuth('/chat/history?limit=100');
      if (data.messages && data.messages.length > 0) {
        const firstMsg = data.messages[0];
        const hasOldWizardWelcome = firstMsg.role === 'assistant' && 
          /registrar hoy|ingresos, gastos, cobros pendientes/i.test(firstMsg.content);
        
        if (hasOldWizardWelcome) {
          await fetchWithAuth('/chat/history', { method: 'DELETE' });
          const welcomeData = await fetchWithAuth('/ai/chat', {
            method: 'POST',
            body: JSON.stringify({ reset: true }),
          });
          setMessages([{ role: 'assistant', content: welcomeData.message }]);
        } else {
          setMessages(data.messages.map((m: Record<string, string>) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          })));
        }
      } else {
        const welcomeData = await fetchWithAuth('/ai/chat', {
          method: 'POST',
          body: JSON.stringify({ reset: true }),
        });
        setMessages([{ role: 'assistant', content: welcomeData.message }]);
      }
    } catch (error) {
      console.error('Load chat history error:', error);
      try {
        const welcomeData = await fetchWithAuth('/ai/chat', {
          method: 'POST',
          body: JSON.stringify({ reset: true }),
        });
        setMessages([{ role: 'assistant', content: welcomeData.message }]);
      } catch (e) {
        console.error('Welcome message error:', e);
      }
    }
  };

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && mode !== 'hidden') {
        setMode('hidden');
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [mode]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = input 
        ? Math.min(textareaRef.current.scrollHeight, 120) + 'px' 
        : '40px';
    }
  }, [input]);

  const resetChat = async () => {
    setMessages([]);
    setInput('');
    
    try {
      await fetchWithAuth('/chat/history', {
        method: 'DELETE',
      });
      
      const data = await fetchWithAuth('/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ reset: true }),
      });
      setMessages([{ role: 'assistant', content: data.message }]);
    } catch (error) {
      console.error('Reset error:', error);
    }
  };

  const sendMessage = async (text?: string) => {
    const messageToSend = text || input.trim();
    if (!messageToSend) return;
    
    voiceTranscriptRef.current = null;
    setIsLoading(true);
    setInput('');
    
    const newMessages = [...messages, { role: 'user' as const, content: messageToSend }];
    setMessages(newMessages);

    try {
      const data = await fetchWithAuth('/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ message: messageToSend }),
      });
      
      setMessages([...newMessages, { role: 'assistant', content: data.message }]);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'No se pudo procesar tu mensaje';
      toast({
        title: "Error",
        description: errMsg,
        variant: "destructive",
      });
      setMessages(newMessages);
    } finally {
      setIsLoading(false);
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  };

  const startRecording = () => {
    try {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      
      if (!SpeechRecognition) {
        toast({
          title: "No soportado",
          description: "Tu navegador no soporta reconocimiento de voz. Proba con Chrome o Edge.",
          variant: "destructive",
        });
        return;
      }

      const recognition = new SpeechRecognition();
      recognition.lang = 'es-AR';
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        const transcript = event.results[0][0].transcript;
        if (transcript) {
          voiceTranscriptRef.current = transcript;
          setInput(transcript);
          setTimeout(() => {
            if (voiceTranscriptRef.current) {
              setInput(voiceTranscriptRef.current);
            }
          }, 100);
        }
        setIsRecording(false);
        setIsTranscribing(false);
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        console.error('Speech recognition error:', event.error);
        setIsRecording(false);
        setIsTranscribing(false);
        
        let errorMsg = "Error al reconocer voz";
        if (event.error === 'no-speech') {
          errorMsg = "No se detecto voz. Intenta hablar mas cerca del microfono.";
        } else if (event.error === 'not-allowed') {
          errorMsg = "Permiso denegado. Habilita el microfono en tu navegador.";
        } else if (event.error === 'network') {
          errorMsg = "Error de red. Verifica tu conexion.";
        }
        
        toast({
          title: "Error de voz",
          description: errorMsg,
          variant: "destructive",
        });
      };

      recognition.onend = () => {
        setIsRecording(false);
        setIsTranscribing(false);
      };

      recognitionRef.current = recognition;
      recognition.start();
      setIsRecording(true);
      setIsTranscribing(true);
    } catch {
      toast({
        title: "Error de microfono",
        description: "No se pudo iniciar el reconocimiento de voz.",
        variant: "destructive",
      });
    }
  };

  const stopRecording = () => {
    if (recognitionRef.current && isRecording) {
      recognitionRef.current.stop();
      setIsRecording(false);
      setIsTranscribing(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    const files = Array.from(e.dataTransfer.files);
    const imageFile = files.find(f => f.type.startsWith('image/'));
    
    if (imageFile) {
      await analyzeImage(imageFile);
    } else {
      toast({
        title: "Archivo no soportado",
        description: "Por favor, arrastra una imagen (JPG, PNG, etc.)",
        variant: "destructive",
      });
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith('image/')) {
      await analyzeImage(file);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const analyzeImage = async (file: File) => {
    setIsAnalyzingImage(true);
    setIsLoading(true);
    
    const userMessage = `[Imagen: ${file.name}]`;
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    
    try {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      
      const base64Image = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result as string;
          const base64 = result.split(',')[1];
          resolve(base64);
        };
        reader.onerror = reject;
      });
      
      const result = await fetchWithAuth('/ai/analyze-bank-statement', {
        method: 'POST',
        body: JSON.stringify({
          imageBase64: base64Image,
          mimeType: file.type,
          accounts: [],
        }),
      });
      
      if (result.error) {
        setMessages(prev => [...prev, { 
          role: 'assistant', 
          content: `No pude analizar la imagen: ${result.error}. Asegurate de que sea un extracto bancario o comprobante claro.` 
        }]);
      } else if (result.transactions && result.transactions.length > 0) {
        const summary = `Encontre ${result.transactions.length} movimiento(s) en el extracto${result.bankName ? ` de ${result.bankName}` : ''}:\n\n` +
          result.transactions.slice(0, 5).map((tx: Record<string, string | number>, i: number) => 
            `${i + 1}. ${tx.type === 'income' ? '💵' : '💸'} ${tx.description}: $${typeof tx.amount === 'number' ? tx.amount.toLocaleString('es-AR') : 'N/A'}`
          ).join('\n') +
          (result.transactions.length > 5 ? `\n\n...y ${result.transactions.length - 5} mas.` : '') +
          '\n\nPara importar estos movimientos, usa el boton **"+"** en la seccion de Movimientos o registralos por WhatsApp.';
        
        setMessages(prev => [...prev, { role: 'assistant', content: summary }]);
      } else {
        setMessages(prev => [...prev, { 
          role: 'assistant', 
          content: 'Analice la imagen pero no encontre movimientos bancarios. Proba con una imagen mas clara de un extracto bancario.' 
        }]);
      }
    } catch (error: unknown) {
      console.error('Image analysis error:', error);
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: 'Hubo un error al analizar la imagen. Intenta de nuevo con una imagen mas clara.' 
      }]);
      toast({
        title: "Error al analizar imagen",
        description: error instanceof Error ? error.message : "No se pudo procesar la imagen",
        variant: "destructive",
      });
    } finally {
      setIsAnalyzingImage(false);
      setIsLoading(false);
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  };

  const toggleMode = () => {
    if (mode === 'hidden') setMode('panel');
    else if (mode === 'panel') setMode('fullscreen');
    else setMode('panel');
  };

  const renderHelpSuggestions = () => {
    if (messages.length > 1) return null;
    
    return (
      <div className="flex flex-wrap gap-2 px-4 py-3" data-testid="help-suggestions">
        {HELP_SUGGESTIONS.map(({ label, icon }) => (
          <Button
            key={label}
            variant="outline"
            size="sm"
            onClick={() => sendMessage(label)}
            className="text-xs bg-white dark:bg-card hover:bg-gray-50 dark:hover:bg-slate-800 border-gray-200 dark:border-slate-800 hover:border-[#00D4FF]/40 transition-colors"
            data-testid={`suggestion-${label.slice(0, 15).replace(/\s/g, '-').toLowerCase()}`}
          >
            <span className="mr-1">{icon}</span> {label}
          </Button>
        ))}
      </div>
    );
  };

  if (mode === 'hidden') {
    return (
      <button
        onClick={() => { setMode('panel'); if (messages.length === 0) resetChat(); }}
        className="fixed bottom-6 right-6 z-50 h-14 w-14 rounded-full bg-gradient-to-br from-[#00D4FF] to-[#FF3366] text-white shadow-lg shadow-[#00D4FF]/30 hover:shadow-xl hover:shadow-[#00D4FF]/40 hover:scale-105 transition-all flex items-center justify-center animate-logo-pulse"
        data-testid="floating-ai-button"
        aria-label="Abrir asistente IA"
      >
        <Sparkles className="h-6 w-6" />
      </button>
    );
  }

  const isFullscreen = mode === 'fullscreen';

  return (
    <>
      {isFullscreen && (
        <div 
          className="fixed inset-0 bg-black/50 z-40 animate-in fade-in duration-200"
          onClick={() => setMode('panel')}
        />
      )}
      
      <div 
        className={`fixed z-50 bg-white dark:bg-card shadow-2xl flex flex-col transition-all duration-300 ease-out ${
          isFullscreen 
            ? 'inset-4 md:inset-8 lg:inset-16 rounded-2xl' 
            : 'top-0 right-0 bottom-0 w-full sm:w-96 md:w-[420px] border-l border-gray-200 dark:border-slate-800'
        }`}
        data-testid="floating-ai-chat"
      >
        <div className="flex items-center justify-between p-4 bg-gradient-to-r from-[#00D4FF] to-[#FF3366] rounded-t-none sm:rounded-t-none">
          <div className="flex items-center gap-3">
            <div className="rounded-full overflow-hidden bg-white dark:bg-card/20 p-0.5">
              <img src={aikeLogo} alt="Aike" className="h-9 w-9 rounded-full object-cover" />
            </div>
            <div>
              <h2 className="font-bold text-white text-base">Aike</h2>
              {organization?.name ? (
                <div className="flex items-center gap-1.5 text-white/80 text-xs">
                  <span>En</span>
                  {organization.logoUrl ? (
                    <img src={organization.logoUrl} alt="" className="h-4 w-4 rounded object-cover" />
                  ) : organization.iconKey ? (
                    React.createElement(getIconByKey(organization.iconKey), { className: "h-3 w-3" })
                  ) : (
                    <Building2 className="h-3 w-3" />
                  )}
                  <span className="truncate max-w-[120px]">{organization.name}</span>
                </div>
              ) : (
                <p className="text-white/70 text-xs">Tu asistente de ayuda</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button 
              onClick={resetChat}
              className="p-2 hover:bg-white/20 rounded-lg transition-colors"
              data-testid="floating-ai-reset"
              aria-label="Nueva conversacion"
              title="Nueva conversacion"
            >
              <RotateCcw className="h-5 w-5 text-white" />
            </button>
            <button 
              onClick={() => setMode('hidden')}
              className="p-2 hover:bg-white/20 rounded-lg transition-colors"
              data-testid="floating-ai-minimize"
              aria-label="Minimizar"
              title="Minimizar"
            >
              <Minus className="h-5 w-5 text-white" />
            </button>
            <button 
              onClick={toggleMode}
              className="p-2 hover:bg-white/20 rounded-lg transition-colors"
              data-testid="floating-ai-maximize"
              aria-label={isFullscreen ? 'Panel' : 'Pantalla completa'}
              title={isFullscreen ? 'Panel' : 'Pantalla completa'}
            >
              {isFullscreen ? <PanelRightClose className="h-5 w-5 text-white" /> : <Maximize2 className="h-5 w-5 text-white" />}
            </button>
            <button 
              onClick={() => setMode('hidden')}
              className="p-2 hover:bg-white/20 rounded-lg transition-colors"
              data-testid="floating-ai-close"
              aria-label="Cerrar"
              title="Cerrar"
            >
              <X className="h-5 w-5 text-white" />
            </button>
          </div>
        </div>

        <div 
          className={`flex-1 overflow-hidden flex flex-col relative ${isDragging ? 'ring-2 ring-[#00D4FF] ring-inset' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDragging && (
            <div className="absolute inset-0 bg-[#00D4FF]/10 backdrop-blur-sm z-10 flex items-center justify-center">
              <div className="text-center p-6 bg-white dark:bg-card rounded-xl shadow-lg">
                <Upload className="h-12 w-12 text-[#00D4FF] mx-auto mb-3" />
                <p className="font-semibold text-gray-700 dark:text-slate-200">Solta la imagen aqui</p>
                <p className="text-sm text-gray-500 dark:text-slate-400">Extracto bancario o comprobante</p>
              </div>
            </div>
          )}
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-4">
              {messages.length === 0 && (
                <div className="text-center text-gray-500 dark:text-slate-400 py-12">
                  <div className="mx-auto w-20 h-20 rounded-full bg-gradient-to-br from-[#00D4FF]/20 to-[#FF3366]/20 flex items-center justify-center mb-4 shadow-lg overflow-hidden">
                    <img src={aikeLogo} alt="Aike" className="h-full w-full object-cover" />
                  </div>
                  <h3 className="font-semibold text-gray-700 dark:text-slate-200 mb-1 text-lg">Hola! Soy Aike</h3>
                  {organization?.name && (
                    <p className="text-xs text-[#00D4FF] mb-3">Trabajando en {organization.name}</p>
                  )}
                  <p className="text-sm mb-2 text-gray-500 dark:text-slate-400">Soy tu asistente de ayuda y guia.</p>
                  <p className="text-sm mb-4 text-gray-500 dark:text-slate-400">Preguntame sobre como usar la app, conceptos financieros o consulta tus datos.</p>
                  <div className="flex items-center justify-center gap-2 text-xs text-gray-400">
                    <HelpCircle className="h-3.5 w-3.5" />
                    <span>Tambien podes arrastrar imagenes de extractos</span>
                  </div>
                </div>
              )}

              {messages.map((msg, i) => (
                <div key={i} className={`flex items-start gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                  <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                    msg.role === 'user' 
                      ? 'bg-gray-200' 
                      : 'bg-gradient-to-br from-[#00D4FF] to-[#FF3366]'
                  }`}>
                    {msg.role === 'user' 
                      ? <span className="text-xs font-medium text-gray-600 dark:text-slate-300">Yo</span>
                      : <Sparkles className="h-4 w-4 text-white" />
                    }
                  </div>
                  <div className={`flex-1 rounded-2xl p-3 text-sm whitespace-pre-wrap ${
                    msg.role === 'user' 
                      ? 'bg-gradient-to-r from-[#00D4FF] to-[#FF3366] text-white rounded-tr-sm' 
                      : 'bg-gray-100 dark:bg-slate-800 text-gray-800 dark:text-slate-100 rounded-tl-sm'
                  }`}>
                    {msg.content}
                  </div>
                </div>
              ))}

              {isLoading && (
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-[#00D4FF] to-[#FF3366] flex items-center justify-center">
                    <Sparkles className="h-4 w-4 text-white" />
                  </div>
                  <div className="bg-gray-100 dark:bg-slate-800 rounded-2xl rounded-tl-sm p-3">
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin text-[#00D4FF]" />
                      <span className="text-sm text-gray-500 dark:text-slate-400">Pensando...</span>
                    </div>
                  </div>
                </div>
              )}
              
              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>

          {renderHelpSuggestions()}

          <div className="p-4 border-t bg-gray-50 dark:bg-slate-900/80 backdrop-blur">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileSelect}
              className="hidden"
              data-testid="floating-ai-file-input"
            />
            <div className="flex gap-2 items-end">
              <textarea
                ref={textareaRef}
                placeholder={isTranscribing ? "Transcribiendo..." : isAnalyzingImage ? "Analizando imagen..." : "Preguntame algo..."}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                disabled={isTranscribing || isLoading || isAnalyzingImage}
                className="flex-1 bg-white dark:bg-card border border-gray-200 dark:border-slate-800 rounded-md px-3 py-2 text-sm resize-none overflow-y-auto focus:outline-none focus:ring-2 focus:ring-[#00D4FF] focus:border-transparent disabled:opacity-50"
                style={{ minHeight: '40px', maxHeight: '120px' }}
                rows={1}
                data-testid="floating-ai-input"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading || isAnalyzingImage}
                data-testid="floating-ai-image"
                title="Subir imagen de extracto"
              >
                {isAnalyzingImage ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <ImageIcon className="h-5 w-5" />
                )}
              </Button>
              <Button
                variant={isRecording ? "destructive" : "outline"}
                size="icon"
                onClick={isRecording ? stopRecording : startRecording}
                disabled={isTranscribing || isLoading || isAnalyzingImage}
                className={isRecording ? "animate-pulse" : ""}
                data-testid="floating-ai-mic"
                title={isRecording ? "Detener grabacion" : "Grabar con microfono"}
              >
                {isTranscribing ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : isRecording ? (
                  <MicOff className="h-5 w-5" />
                ) : (
                  <Mic className="h-5 w-5" />
                )}
              </Button>
              <Button 
                className="bg-gradient-to-r from-[#00D4FF] to-[#FF3366] hover:from-[#00D4FF]/90 hover:to-[#FF3366]/90 px-4 shadow-lg shadow-[#00D4FF]/20"
                onClick={() => sendMessage()}
                disabled={isLoading || isTranscribing || isAnalyzingImage || !input}
                data-testid="floating-ai-send"
              >
                {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
