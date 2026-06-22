import React, { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Upload, Camera, Loader2, User, UserCircle, UserCircle2, Smile, Ghost, Bot, Cat, Dog, Bird, Fish, Rabbit, Squirrel, Turtle, Bug, Flower2, Heart, Star, Sparkles, Zap, Sun, Moon, Cloud, Rainbow, Flame, Snowflake, Leaf, TreeDeciduous, Mountain, Compass, Anchor, Crown, Shield, Award, Trophy, Medal, Target, Rocket, Plane, Car, Bike, Palette, Music, Gamepad2, Headphones, Camera as CameraIcon, Coffee, Pizza, IceCream, Cake, Gift, PartyPopper, Pencil } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { fetchWithAuth } from '@/lib/api';

const PROFILE_ICON_OPTIONS: { key: string; icon: LucideIcon; label: string }[] = [
  { key: 'user', icon: User, label: 'Usuario' },
  { key: 'userCircle', icon: UserCircle, label: 'Círculo' },
  { key: 'userCircle2', icon: UserCircle2, label: 'Círculo 2' },
  { key: 'smile', icon: Smile, label: 'Sonrisa' },
  { key: 'ghost', icon: Ghost, label: 'Fantasma' },
  { key: 'bot', icon: Bot, label: 'Robot' },
  { key: 'cat', icon: Cat, label: 'Gato' },
  { key: 'dog', icon: Dog, label: 'Perro' },
  { key: 'bird', icon: Bird, label: 'Pájaro' },
  { key: 'fish', icon: Fish, label: 'Pez' },
  { key: 'rabbit', icon: Rabbit, label: 'Conejo' },
  { key: 'squirrel', icon: Squirrel, label: 'Ardilla' },
  { key: 'turtle', icon: Turtle, label: 'Tortuga' },
  { key: 'bug', icon: Bug, label: 'Bicho' },
  { key: 'flower', icon: Flower2, label: 'Flor' },
  { key: 'heart', icon: Heart, label: 'Corazón' },
  { key: 'star', icon: Star, label: 'Estrella' },
  { key: 'sparkles', icon: Sparkles, label: 'Brillo' },
  { key: 'zap', icon: Zap, label: 'Rayo' },
  { key: 'sun', icon: Sun, label: 'Sol' },
  { key: 'moon', icon: Moon, label: 'Luna' },
  { key: 'cloud', icon: Cloud, label: 'Nube' },
  { key: 'rainbow', icon: Rainbow, label: 'Arcoíris' },
  { key: 'flame', icon: Flame, label: 'Llama' },
  { key: 'snowflake', icon: Snowflake, label: 'Copo' },
  { key: 'leaf', icon: Leaf, label: 'Hoja' },
  { key: 'tree', icon: TreeDeciduous, label: 'Árbol' },
  { key: 'mountain', icon: Mountain, label: 'Montaña' },
  { key: 'compass', icon: Compass, label: 'Brújula' },
  { key: 'anchor', icon: Anchor, label: 'Ancla' },
  { key: 'crown', icon: Crown, label: 'Corona' },
  { key: 'shield', icon: Shield, label: 'Escudo' },
  { key: 'award', icon: Award, label: 'Premio' },
  { key: 'trophy', icon: Trophy, label: 'Trofeo' },
  { key: 'medal', icon: Medal, label: 'Medalla' },
  { key: 'target', icon: Target, label: 'Objetivo' },
  { key: 'rocket', icon: Rocket, label: 'Cohete' },
  { key: 'plane', icon: Plane, label: 'Avión' },
  { key: 'car', icon: Car, label: 'Auto' },
  { key: 'bike', icon: Bike, label: 'Bici' },
  { key: 'palette', icon: Palette, label: 'Paleta' },
  { key: 'music', icon: Music, label: 'Música' },
  { key: 'gamepad', icon: Gamepad2, label: 'Juego' },
  { key: 'headphones', icon: Headphones, label: 'Audio' },
  { key: 'camera', icon: CameraIcon, label: 'Cámara' },
  { key: 'coffee', icon: Coffee, label: 'Café' },
  { key: 'pizza', icon: Pizza, label: 'Pizza' },
  { key: 'iceCream', icon: IceCream, label: 'Helado' },
  { key: 'cake', icon: Cake, label: 'Torta' },
  { key: 'gift', icon: Gift, label: 'Regalo' },
  { key: 'party', icon: PartyPopper, label: 'Fiesta' },
];

export { PROFILE_ICON_OPTIONS };

export function getProfileIconByKey(key: string | null | undefined) {
  if (!key) return User;
  const found = PROFILE_ICON_OPTIONS.find(opt => opt.key === key);
  return found?.icon || User;
}

interface UserProfilePickerProps {
  currentImageUrl?: string | null;
  currentIconKey?: string | null;
  onImageChange: (url: string | null) => void;
  onIconChange: (key: string | null) => void;
  size?: 'sm' | 'md' | 'lg';
  showUpload?: boolean;
}

export function UserProfilePicker({
  currentImageUrl,
  currentIconKey,
  onImageChange,
  onIconChange,
  size = 'md',
  showUpload = true,
}: UserProfilePickerProps) {
  const [selectedIcon, setSelectedIcon] = useState<string | null>(currentIconKey || null);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(currentImageUrl || null);
  const [isUploading, setIsUploading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSelectedIcon(currentIconKey || null);
    setPreviewImageUrl(currentImageUrl || null);
  }, [currentIconKey, currentImageUrl]);

  const sizeClasses = {
    sm: 'h-12 w-12',
    md: 'h-16 w-16',
    lg: 'h-20 w-20',
  };

  const iconSizeClasses = {
    sm: 'h-6 w-6',
    md: 'h-8 w-8',
    lg: 'h-10 w-10',
  };

  const handleIconSelect = (iconKey: string) => {
    setSelectedIcon(iconKey);
    setPreviewImageUrl(null);
    onIconChange(iconKey);
    setIsOpen(false);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
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

      setPreviewImageUrl(objectPath);
      setSelectedIcon(null);
      onImageChange(objectPath);
      setIsOpen(false);
    } catch (error) {
      console.error('Upload error:', error);
    } finally {
      setIsUploading(false);
      e.target.value = '';
    }
  };

  const SelectedIconComponent = selectedIcon ? getProfileIconByKey(selectedIcon) : null;

  return (
    <div className="flex items-center gap-4">
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <button 
            type="button"
            className="relative group cursor-pointer"
            data-testid="profile-picker-trigger"
          >
            <div className={`${sizeClasses[size]} rounded-full bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center overflow-hidden shadow-lg border-2 border-white`}>
              {previewImageUrl ? (
                <img src={previewImageUrl} alt="Perfil" className="h-full w-full object-cover" />
              ) : SelectedIconComponent ? (
                <SelectedIconComponent className={`${iconSizeClasses[size]} text-white`} />
              ) : (
                <User className={`${iconSizeClasses[size]} text-white`} />
              )}
            </div>
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
              <Pencil className="h-4 w-4 text-white" />
            </div>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-3" align="start">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelect}
            className="hidden"
          />
          
          <Tabs defaultValue="icons" className="w-full">
            <TabsList className="grid w-full grid-cols-2 h-8">
              <TabsTrigger value="icons" className="text-xs h-7">Iconos</TabsTrigger>
              {showUpload && <TabsTrigger value="upload" className="text-xs h-7">Subir Foto</TabsTrigger>}
            </TabsList>

            <TabsContent value="icons" className="mt-2">
              <ScrollArea className="h-32">
                <div className="grid grid-cols-8 gap-1">
                  {PROFILE_ICON_OPTIONS.map((option) => {
                    const Icon = option.icon;
                    const isSelected = selectedIcon === option.key && !previewImageUrl;
                    return (
                      <button
                        key={option.key}
                        type="button"
                        onClick={() => handleIconSelect(option.key)}
                        className={`p-1.5 rounded transition-all ${
                          isSelected
                            ? 'bg-primary text-white scale-110 shadow'
                            : 'hover:bg-muted text-muted-foreground hover:text-foreground'
                        }`}
                        title={option.label}
                        data-testid={`profile-icon-${option.key}`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
            </TabsContent>

            {showUpload && (
              <TabsContent value="upload" className="mt-2">
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="border border-dashed border-muted-foreground/30 rounded-lg p-4 text-center cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-all"
                >
                  {isUploading ? (
                    <div className="flex flex-col items-center gap-1">
                      <Loader2 className="h-5 w-5 animate-spin text-primary" />
                      <p className="text-xs text-muted-foreground">Subiendo...</p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-1">
                      <Camera className="h-5 w-5 text-muted-foreground" />
                      <p className="text-xs font-medium">Subir foto</p>
                      <p className="text-[10px] text-muted-foreground">JPG, PNG. Máx 5MB</p>
                    </div>
                  )}
                </div>
              </TabsContent>
            )}
          </Tabs>
        </PopoverContent>
      </Popover>
      
      <div className="text-sm">
        <p className="font-medium">{previewImageUrl ? 'Foto personalizada' : selectedIcon ? 'Icono de perfil' : 'Sin foto'}</p>
        <p className="text-xs text-muted-foreground">Clic para cambiar</p>
      </div>
    </div>
  );
}
