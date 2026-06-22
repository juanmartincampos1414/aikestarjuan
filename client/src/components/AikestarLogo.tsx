import React from 'react';
import aikestarIsotipo from '@/assets/aikestar-isotipo.jpg';

interface AikestarLogoProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'light' | 'dark';
  showText?: boolean;
}

export default function AikestarLogo({ 
  className = '', 
  size = 'md', 
  variant = 'light',
  showText = true 
}: AikestarLogoProps) {
  const sizeClasses = {
    sm: 'text-lg',
    md: 'text-xl',
    lg: 'text-2xl',
    xl: 'text-3xl',
  };

  const imageSizes = {
    sm: 'h-7 w-7',
    md: 'h-9 w-9',
    lg: 'h-11 w-11',
    xl: 'h-14 w-14',
  };

  const textColor = variant === 'light' ? 'text-white' : 'text-slate-800';

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <img 
        src={aikestarIsotipo} 
        alt="Aikestar" 
        className={`${imageSizes[size]} rounded-lg object-contain`}
      />
      {showText && (
        <span className={`font-bold tracking-tight ${sizeClasses[size]} ${textColor}`}>
          Aike<span className="text-[#ED1E3A]">star</span>
        </span>
      )}
    </div>
  );
}
