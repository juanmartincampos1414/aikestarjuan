import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { fetchWithAuth } from '@/lib/api';
import { 
  Building, Building2, Store, Briefcase, Factory, Home, 
  ShoppingBag, ShoppingCart, Coffee, Utensils, Pizza, IceCream,
  Car, Truck, Plane, Ship, Train, Bus,
  Stethoscope, Heart, Pill, Activity, Syringe, Hospital,
  GraduationCap, BookOpen, Library, School, Pencil, Calculator,
  Laptop, Monitor, Smartphone, Cpu, Server, Database,
  Camera, Film, Music, Headphones, Mic, Radio,
  Paintbrush, Palette, Scissors, Hammer, Wrench, Settings,
  Leaf, Flower, Trees, Sun, Moon, Cloud,
  Dumbbell, Trophy, Medal, Target, Zap, Flame,
  CreditCard, Wallet, PiggyBank, TrendingUp, BarChart, LineChart,
  Users, UserCheck, Globe, MapPin, Compass, Navigation,
  Shield, Lock, Key, Award, Star, Crown,
  Package, Gift, Box, Truck as TruckIcon, Warehouse, Container,
  Lightbulb, Rocket, Sparkles, Diamond, Gem, CircleDollarSign,
  Upload, Loader2, Check, X, Image as ImageIcon
} from 'lucide-react';

const ICON_OPTIONS = [
  { key: 'building', icon: Building, label: 'Edificio' },
  { key: 'building2', icon: Building2, label: 'Edificio 2' },
  { key: 'store', icon: Store, label: 'Tienda' },
  { key: 'briefcase', icon: Briefcase, label: 'Maletín' },
  { key: 'factory', icon: Factory, label: 'Fábrica' },
  { key: 'home', icon: Home, label: 'Casa' },
  { key: 'shoppingBag', icon: ShoppingBag, label: 'Bolsa' },
  { key: 'shoppingCart', icon: ShoppingCart, label: 'Carrito' },
  { key: 'coffee', icon: Coffee, label: 'Café' },
  { key: 'utensils', icon: Utensils, label: 'Restaurante' },
  { key: 'pizza', icon: Pizza, label: 'Pizza' },
  { key: 'iceCream', icon: IceCream, label: 'Helado' },
  { key: 'car', icon: Car, label: 'Auto' },
  { key: 'truck', icon: Truck, label: 'Camión' },
  { key: 'plane', icon: Plane, label: 'Avión' },
  { key: 'ship', icon: Ship, label: 'Barco' },
  { key: 'train', icon: Train, label: 'Tren' },
  { key: 'bus', icon: Bus, label: 'Bus' },
  { key: 'stethoscope', icon: Stethoscope, label: 'Estetoscopio' },
  { key: 'heart', icon: Heart, label: 'Corazón' },
  { key: 'pill', icon: Pill, label: 'Medicina' },
  { key: 'activity', icon: Activity, label: 'Actividad' },
  { key: 'syringe', icon: Syringe, label: 'Jeringa' },
  { key: 'hospital', icon: Hospital, label: 'Hospital' },
  { key: 'graduationCap', icon: GraduationCap, label: 'Educación' },
  { key: 'bookOpen', icon: BookOpen, label: 'Libro' },
  { key: 'library', icon: Library, label: 'Biblioteca' },
  { key: 'school', icon: School, label: 'Escuela' },
  { key: 'pencil', icon: Pencil, label: 'Lápiz' },
  { key: 'calculator', icon: Calculator, label: 'Calculadora' },
  { key: 'laptop', icon: Laptop, label: 'Laptop' },
  { key: 'monitor', icon: Monitor, label: 'Monitor' },
  { key: 'smartphone', icon: Smartphone, label: 'Celular' },
  { key: 'cpu', icon: Cpu, label: 'CPU' },
  { key: 'server', icon: Server, label: 'Servidor' },
  { key: 'database', icon: Database, label: 'Base de datos' },
  { key: 'camera', icon: Camera, label: 'Cámara' },
  { key: 'film', icon: Film, label: 'Film' },
  { key: 'music', icon: Music, label: 'Música' },
  { key: 'headphones', icon: Headphones, label: 'Auriculares' },
  { key: 'mic', icon: Mic, label: 'Micrófono' },
  { key: 'radio', icon: Radio, label: 'Radio' },
  { key: 'paintbrush', icon: Paintbrush, label: 'Pincel' },
  { key: 'palette', icon: Palette, label: 'Paleta' },
  { key: 'scissors', icon: Scissors, label: 'Tijeras' },
  { key: 'hammer', icon: Hammer, label: 'Martillo' },
  { key: 'wrench', icon: Wrench, label: 'Llave' },
  { key: 'settings', icon: Settings, label: 'Engranaje' },
  { key: 'leaf', icon: Leaf, label: 'Hoja' },
  { key: 'flower', icon: Flower, label: 'Flor' },
  { key: 'trees', icon: Trees, label: 'Árboles' },
  { key: 'sun', icon: Sun, label: 'Sol' },
  { key: 'moon', icon: Moon, label: 'Luna' },
  { key: 'cloud', icon: Cloud, label: 'Nube' },
  { key: 'dumbbell', icon: Dumbbell, label: 'Pesas' },
  { key: 'trophy', icon: Trophy, label: 'Trofeo' },
  { key: 'medal', icon: Medal, label: 'Medalla' },
  { key: 'target', icon: Target, label: 'Objetivo' },
  { key: 'zap', icon: Zap, label: 'Rayo' },
  { key: 'flame', icon: Flame, label: 'Fuego' },
  { key: 'creditCard', icon: CreditCard, label: 'Tarjeta' },
  { key: 'wallet', icon: Wallet, label: 'Billetera' },
  { key: 'piggyBank', icon: PiggyBank, label: 'Alcancía' },
  { key: 'trendingUp', icon: TrendingUp, label: 'Tendencia' },
  { key: 'barChart', icon: BarChart, label: 'Gráfico' },
  { key: 'lineChart', icon: LineChart, label: 'Línea' },
  { key: 'users', icon: Users, label: 'Usuarios' },
  { key: 'userCheck', icon: UserCheck, label: 'Usuario' },
  { key: 'globe', icon: Globe, label: 'Globo' },
  { key: 'mapPin', icon: MapPin, label: 'Ubicación' },
  { key: 'compass', icon: Compass, label: 'Brújula' },
  { key: 'navigation', icon: Navigation, label: 'Navegación' },
  { key: 'shield', icon: Shield, label: 'Escudo' },
  { key: 'lock', icon: Lock, label: 'Candado' },
  { key: 'key', icon: Key, label: 'Llave' },
  { key: 'award', icon: Award, label: 'Premio' },
  { key: 'star', icon: Star, label: 'Estrella' },
  { key: 'crown', icon: Crown, label: 'Corona' },
  { key: 'package', icon: Package, label: 'Paquete' },
  { key: 'gift', icon: Gift, label: 'Regalo' },
  { key: 'box', icon: Box, label: 'Caja' },
  { key: 'warehouse', icon: Warehouse, label: 'Depósito' },
  { key: 'lightbulb', icon: Lightbulb, label: 'Idea' },
  { key: 'rocket', icon: Rocket, label: 'Cohete' },
  { key: 'sparkles', icon: Sparkles, label: 'Brillo' },
  { key: 'diamond', icon: Diamond, label: 'Diamante' },
  { key: 'gem', icon: Gem, label: 'Gema' },
  { key: 'circleDollarSign', icon: CircleDollarSign, label: 'Dólar' },
];

export function getIconByKey(key: string | null | undefined) {
  if (!key) return Building;
  const found = ICON_OPTIONS.find(opt => opt.key === key);
  return found?.icon || Building;
}

interface OrganizationBrandPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentLogoUrl?: string | null;
  currentIconKey?: string | null;
  currentContactEmail?: string | null;
  currentContactPhone?: string | null;
  onSave: (data: { logoUrl?: string | null; iconKey?: string | null; contactEmail?: string | null; contactPhone?: string | null }) => Promise<void>;
  orgId?: string;
}

export function OrganizationBrandPicker({
  open,
  onOpenChange,
  currentLogoUrl,
  currentIconKey,
  currentContactEmail,
  currentContactPhone,
  onSave,
  orgId,
}: OrganizationBrandPickerProps) {
  const { toast } = useToast();
  const [selectedIcon, setSelectedIcon] = useState<string | null>(currentIconKey || null);
  const [previewLogoUrl, setPreviewLogoUrl] = useState<string | null>(currentLogoUrl || null);
  const [contactEmail, setContactEmail] = useState<string>(currentContactEmail || '');
  const [contactPhone, setContactPhone] = useState<string>(currentContactPhone || '');
  const [isUploading, setIsUploading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<string>(currentLogoUrl ? 'upload' : 'icons');

  const handleIconSelect = (iconKey: string) => {
    setSelectedIcon(iconKey);
    setPreviewLogoUrl(null);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (!file.type.startsWith('image/')) {
      toast({
        title: "Error",
        description: "Solo se permiten archivos de imagen",
        variant: "destructive",
      });
      return;
    }
    
    if (file.size > 2 * 1024 * 1024) {
      toast({
        title: "Error", 
        description: "El archivo no puede superar 2MB",
        variant: "destructive",
      });
      return;
    }

    setIsUploading(true);
    
    try {
      const { uploadURL, objectPath } = await fetchWithAuth('/uploads/request-url', {
        method: 'POST',
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          contentType: file.type,
        }),
      });
      
      await fetch(uploadURL, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      
      setPreviewLogoUrl(objectPath);
      setSelectedIcon(null);
      
      toast({
        title: "Imagen subida",
        description: "La imagen se subió correctamente.",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo subir la imagen",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
      e.target.value = '';
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave({
        logoUrl: previewLogoUrl || null,
        iconKey: selectedIcon || null,
        contactEmail: contactEmail.trim() || null,
        contactPhone: contactPhone.trim() || null,
      });
      onOpenChange(false);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo guardar",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearLogo = () => {
    setPreviewLogoUrl(null);
  };

  const SelectedIconComponent = selectedIcon ? getIconByKey(selectedIcon) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Datos de la Organización</DialogTitle>
          <DialogDescription>
            Elegí un logo o icono y completá los datos de contacto que aparecen en el PDF de los presupuestos.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="icons">Iconos</TabsTrigger>
            <TabsTrigger value="upload">Subir Imagen</TabsTrigger>
          </TabsList>

          <TabsContent value="icons" className="mt-4">
            <ScrollArea className="h-64 pr-4">
              <div className="grid grid-cols-6 gap-2">
                {ICON_OPTIONS.map(({ key, icon: Icon, label }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleIconSelect(key)}
                    className={`p-3 rounded-lg border-2 transition-all hover:bg-primary/10 ${
                      selectedIcon === key 
                        ? 'border-primary bg-primary/10' 
                        : 'border-transparent hover:border-primary/30'
                    }`}
                    title={label}
                    data-testid={`icon-option-${key}`}
                  >
                    <Icon className="h-5 w-5 mx-auto text-muted-foreground" />
                  </button>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="upload" className="mt-4">
            <div className="space-y-4">
              <div className="flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-lg">
                {previewLogoUrl ? (
                  <div className="relative">
                    <img 
                      src={previewLogoUrl} 
                      alt="Preview" 
                      className="h-24 w-24 object-cover rounded-lg"
                    />
                    <button
                      type="button"
                      onClick={handleClearLogo}
                      className="absolute -top-2 -right-2 p-1 bg-destructive text-white rounded-full"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ) : (
                  <>
                    <ImageIcon className="h-12 w-12 text-muted-foreground mb-2" />
                    <p className="text-sm text-muted-foreground mb-4">
                      Arrastrá una imagen o hacé clic para seleccionar
                    </p>
                  </>
                )}
                
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleFileUpload}
                  className="hidden"
                  id="logo-upload-input"
                  disabled={isUploading}
                />
                <label htmlFor="logo-upload-input">
                  <Button 
                    variant="outline" 
                    disabled={isUploading}
                    asChild
                  >
                    <span className="cursor-pointer">
                      {isUploading ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Subiendo...
                        </>
                      ) : (
                        <>
                          <Upload className="h-4 w-4 mr-2" />
                          {previewLogoUrl ? 'Cambiar imagen' : 'Seleccionar imagen'}
                        </>
                      )}
                    </span>
                  </Button>
                </label>
                <p className="text-xs text-muted-foreground mt-2">
                  PNG, JPG o GIF. Máximo 2MB.
                </p>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <div className="space-y-3 pt-4 border-t">
          <p className="text-sm font-medium">Datos de contacto para el PDF</p>
          <p className="text-xs text-muted-foreground -mt-2">
            Aparecen en el membrete de los presupuestos. Si los dejás vacíos, se usan los datos de quien descarga el PDF.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="org-contact-email">Email de contacto</Label>
              <Input
                id="org-contact-email"
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder="contacto@empresa.com"
                data-testid="input-org-contact-email"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="org-contact-phone">Teléfono de contacto</Label>
              <Input
                id="org-contact-phone"
                type="tel"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                placeholder="+54 11 1234-5678"
                data-testid="input-org-contact-phone"
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between pt-4 border-t">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Vista previa:</span>
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center overflow-hidden">
              {previewLogoUrl ? (
                <img src={previewLogoUrl} alt="Preview" className="h-full w-full object-cover" />
              ) : SelectedIconComponent ? (
                <SelectedIconComponent className="h-5 w-5 text-primary" />
              ) : (
                <Building className="h-5 w-5 text-primary" />
              )}
            </div>
          </div>
          
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Guardando...
                </>
              ) : (
                <>
                  <Check className="h-4 w-4 mr-2" />
                  Guardar
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { ICON_OPTIONS };
