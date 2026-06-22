import { useState, useRef, useEffect, useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ChevronDown, Search } from 'lucide-react';
import { normalizePhoneInput, formatArgentineMobilePretty } from '@shared/phone';

interface Country {
  code: string;
  name: string;
  dial: string;
  flag: string;
}

const COUNTRIES: Country[] = [
  { code: 'AR', name: 'Argentina', dial: '54', flag: '🇦🇷' },
  { code: 'US', name: 'Estados Unidos', dial: '1', flag: '🇺🇸' },
  { code: 'UY', name: 'Uruguay', dial: '598', flag: '🇺🇾' },
  { code: 'CL', name: 'Chile', dial: '56', flag: '🇨🇱' },
  { code: 'BR', name: 'Brasil', dial: '55', flag: '🇧🇷' },
  { code: 'MX', name: 'México', dial: '52', flag: '🇲🇽' },
  { code: 'CO', name: 'Colombia', dial: '57', flag: '🇨🇴' },
  { code: 'PE', name: 'Perú', dial: '51', flag: '🇵🇪' },
  { code: 'EC', name: 'Ecuador', dial: '593', flag: '🇪🇨' },
  { code: 'VE', name: 'Venezuela', dial: '58', flag: '🇻🇪' },
  { code: 'PY', name: 'Paraguay', dial: '595', flag: '🇵🇾' },
  { code: 'BO', name: 'Bolivia', dial: '591', flag: '🇧🇴' },
  { code: 'PA', name: 'Panamá', dial: '507', flag: '🇵🇦' },
  { code: 'CR', name: 'Costa Rica', dial: '506', flag: '🇨🇷' },
  { code: 'GT', name: 'Guatemala', dial: '502', flag: '🇬🇹' },
  { code: 'HN', name: 'Honduras', dial: '504', flag: '🇭🇳' },
  { code: 'SV', name: 'El Salvador', dial: '503', flag: '🇸🇻' },
  { code: 'NI', name: 'Nicaragua', dial: '505', flag: '🇳🇮' },
  { code: 'CU', name: 'Cuba', dial: '53', flag: '🇨🇺' },
  { code: 'DO', name: 'Rep. Dominicana', dial: '1809', flag: '🇩🇴' },
  { code: 'PR', name: 'Puerto Rico', dial: '1787', flag: '🇵🇷' },
  { code: 'ES', name: 'España', dial: '34', flag: '🇪🇸' },
  { code: 'GB', name: 'Reino Unido', dial: '44', flag: '🇬🇧' },
  { code: 'DE', name: 'Alemania', dial: '49', flag: '🇩🇪' },
  { code: 'FR', name: 'Francia', dial: '33', flag: '🇫🇷' },
  { code: 'IT', name: 'Italia', dial: '39', flag: '🇮🇹' },
  { code: 'PT', name: 'Portugal', dial: '351', flag: '🇵🇹' },
  { code: 'NL', name: 'Países Bajos', dial: '31', flag: '🇳🇱' },
  { code: 'BE', name: 'Bélgica', dial: '32', flag: '🇧🇪' },
  { code: 'CH', name: 'Suiza', dial: '41', flag: '🇨🇭' },
  { code: 'AT', name: 'Austria', dial: '43', flag: '🇦🇹' },
  { code: 'SE', name: 'Suecia', dial: '46', flag: '🇸🇪' },
  { code: 'NO', name: 'Noruega', dial: '47', flag: '🇳🇴' },
  { code: 'DK', name: 'Dinamarca', dial: '45', flag: '🇩🇰' },
  { code: 'FI', name: 'Finlandia', dial: '358', flag: '🇫🇮' },
  { code: 'PL', name: 'Polonia', dial: '48', flag: '🇵🇱' },
  { code: 'CZ', name: 'Rep. Checa', dial: '420', flag: '🇨🇿' },
  { code: 'RO', name: 'Rumania', dial: '40', flag: '🇷🇴' },
  { code: 'HU', name: 'Hungría', dial: '36', flag: '🇭🇺' },
  { code: 'GR', name: 'Grecia', dial: '30', flag: '🇬🇷' },
  { code: 'IE', name: 'Irlanda', dial: '353', flag: '🇮🇪' },
  { code: 'HR', name: 'Croacia', dial: '385', flag: '🇭🇷' },
  { code: 'RS', name: 'Serbia', dial: '381', flag: '🇷🇸' },
  { code: 'BG', name: 'Bulgaria', dial: '359', flag: '🇧🇬' },
  { code: 'SK', name: 'Eslovaquia', dial: '421', flag: '🇸🇰' },
  { code: 'SI', name: 'Eslovenia', dial: '386', flag: '🇸🇮' },
  { code: 'LT', name: 'Lituania', dial: '370', flag: '🇱🇹' },
  { code: 'LV', name: 'Letonia', dial: '371', flag: '🇱🇻' },
  { code: 'EE', name: 'Estonia', dial: '372', flag: '🇪🇪' },
  { code: 'UA', name: 'Ucrania', dial: '380', flag: '🇺🇦' },
  { code: 'RU', name: 'Rusia', dial: '7', flag: '🇷🇺' },
  { code: 'TR', name: 'Turquía', dial: '90', flag: '🇹🇷' },
  { code: 'IL', name: 'Israel', dial: '972', flag: '🇮🇱' },
  { code: 'SA', name: 'Arabia Saudita', dial: '966', flag: '🇸🇦' },
  { code: 'AE', name: 'Emiratos Árabes', dial: '971', flag: '🇦🇪' },
  { code: 'QA', name: 'Qatar', dial: '974', flag: '🇶🇦' },
  { code: 'KW', name: 'Kuwait', dial: '965', flag: '🇰🇼' },
  { code: 'EG', name: 'Egipto', dial: '20', flag: '🇪🇬' },
  { code: 'MA', name: 'Marruecos', dial: '212', flag: '🇲🇦' },
  { code: 'ZA', name: 'Sudáfrica', dial: '27', flag: '🇿🇦' },
  { code: 'NG', name: 'Nigeria', dial: '234', flag: '🇳🇬' },
  { code: 'KE', name: 'Kenia', dial: '254', flag: '🇰🇪' },
  { code: 'GH', name: 'Ghana', dial: '233', flag: '🇬🇭' },
  { code: 'TZ', name: 'Tanzania', dial: '255', flag: '🇹🇿' },
  { code: 'ET', name: 'Etiopía', dial: '251', flag: '🇪🇹' },
  { code: 'TN', name: 'Túnez', dial: '216', flag: '🇹🇳' },
  { code: 'DZ', name: 'Argelia', dial: '213', flag: '🇩🇿' },
  { code: 'SN', name: 'Senegal', dial: '221', flag: '🇸🇳' },
  { code: 'CM', name: 'Camerún', dial: '237', flag: '🇨🇲' },
  { code: 'CI', name: "Costa de Marfil", dial: '225', flag: '🇨🇮' },
  { code: 'CD', name: 'R.D. del Congo', dial: '243', flag: '🇨🇩' },
  { code: 'AO', name: 'Angola', dial: '244', flag: '🇦🇴' },
  { code: 'MZ', name: 'Mozambique', dial: '258', flag: '🇲🇿' },
  { code: 'UG', name: 'Uganda', dial: '256', flag: '🇺🇬' },
  { code: 'RW', name: 'Ruanda', dial: '250', flag: '🇷🇼' },
  { code: 'CN', name: 'China', dial: '86', flag: '🇨🇳' },
  { code: 'JP', name: 'Japón', dial: '81', flag: '🇯🇵' },
  { code: 'KR', name: 'Corea del Sur', dial: '82', flag: '🇰🇷' },
  { code: 'IN', name: 'India', dial: '91', flag: '🇮🇳' },
  { code: 'PK', name: 'Pakistán', dial: '92', flag: '🇵🇰' },
  { code: 'BD', name: 'Bangladés', dial: '880', flag: '🇧🇩' },
  { code: 'ID', name: 'Indonesia', dial: '62', flag: '🇮🇩' },
  { code: 'MY', name: 'Malasia', dial: '60', flag: '🇲🇾' },
  { code: 'PH', name: 'Filipinas', dial: '63', flag: '🇵🇭' },
  { code: 'TH', name: 'Tailandia', dial: '66', flag: '🇹🇭' },
  { code: 'VN', name: 'Vietnam', dial: '84', flag: '🇻🇳' },
  { code: 'SG', name: 'Singapur', dial: '65', flag: '🇸🇬' },
  { code: 'TW', name: 'Taiwán', dial: '886', flag: '🇹🇼' },
  { code: 'HK', name: 'Hong Kong', dial: '852', flag: '🇭🇰' },
  { code: 'AU', name: 'Australia', dial: '61', flag: '🇦🇺' },
  { code: 'NZ', name: 'Nueva Zelanda', dial: '64', flag: '🇳🇿' },
  { code: 'CA', name: 'Canadá', dial: '1', flag: '🇨🇦' },
  { code: 'JM', name: 'Jamaica', dial: '1876', flag: '🇯🇲' },
  { code: 'TT', name: 'Trinidad y Tobago', dial: '1868', flag: '🇹🇹' },
  { code: 'HT', name: 'Haití', dial: '509', flag: '🇭🇹' },
  { code: 'BZ', name: 'Belice', dial: '501', flag: '🇧🇿' },
  { code: 'GY', name: 'Guyana', dial: '592', flag: '🇬🇾' },
  { code: 'SR', name: 'Surinam', dial: '597', flag: '🇸🇷' },
  { code: 'BB', name: 'Barbados', dial: '1246', flag: '🇧🇧' },
  { code: 'BS', name: 'Bahamas', dial: '1242', flag: '🇧🇸' },
  { code: 'LB', name: 'Líbano', dial: '961', flag: '🇱🇧' },
  { code: 'JO', name: 'Jordania', dial: '962', flag: '🇯🇴' },
  { code: 'IQ', name: 'Irak', dial: '964', flag: '🇮🇶' },
  { code: 'IR', name: 'Irán', dial: '98', flag: '🇮🇷' },
  { code: 'AF', name: 'Afganistán', dial: '93', flag: '🇦🇫' },
  { code: 'NP', name: 'Nepal', dial: '977', flag: '🇳🇵' },
  { code: 'LK', name: 'Sri Lanka', dial: '94', flag: '🇱🇰' },
  { code: 'MM', name: 'Myanmar', dial: '95', flag: '🇲🇲' },
  { code: 'KH', name: 'Camboya', dial: '855', flag: '🇰🇭' },
  { code: 'LA', name: 'Laos', dial: '856', flag: '🇱🇦' },
  { code: 'MN', name: 'Mongolia', dial: '976', flag: '🇲🇳' },
  { code: 'KZ', name: 'Kazajistán', dial: '7', flag: '🇰🇿' },
  { code: 'UZ', name: 'Uzbekistán', dial: '998', flag: '🇺🇿' },
  { code: 'GE', name: 'Georgia', dial: '995', flag: '🇬🇪' },
  { code: 'AM', name: 'Armenia', dial: '374', flag: '🇦🇲' },
  { code: 'AZ', name: 'Azerbaiyán', dial: '994', flag: '🇦🇿' },
  { code: 'IS', name: 'Islandia', dial: '354', flag: '🇮🇸' },
  { code: 'LU', name: 'Luxemburgo', dial: '352', flag: '🇱🇺' },
  { code: 'MT', name: 'Malta', dial: '356', flag: '🇲🇹' },
  { code: 'CY', name: 'Chipre', dial: '357', flag: '🇨🇾' },
  { code: 'AL', name: 'Albania', dial: '355', flag: '🇦🇱' },
  { code: 'MK', name: 'Macedonia del Norte', dial: '389', flag: '🇲🇰' },
  { code: 'BA', name: 'Bosnia y Herzegovina', dial: '387', flag: '🇧🇦' },
  { code: 'ME', name: 'Montenegro', dial: '382', flag: '🇲🇪' },
  { code: 'MD', name: 'Moldavia', dial: '373', flag: '🇲🇩' },
  { code: 'BY', name: 'Bielorrusia', dial: '375', flag: '🇧🇾' },
  { code: 'FJ', name: 'Fiyi', dial: '679', flag: '🇫🇯' },
  { code: 'PG', name: 'Papúa Nueva Guinea', dial: '675', flag: '🇵🇬' },
  { code: 'LY', name: 'Libia', dial: '218', flag: '🇱🇾' },
  { code: 'SD', name: 'Sudán', dial: '249', flag: '🇸🇩' },
  { code: 'MG', name: 'Madagascar', dial: '261', flag: '🇲🇬' },
  { code: 'ZW', name: 'Zimbabue', dial: '263', flag: '🇿🇼' },
  { code: 'ZM', name: 'Zambia', dial: '260', flag: '🇿🇲' },
  { code: 'BW', name: 'Botsuana', dial: '267', flag: '🇧🇼' },
  { code: 'NA', name: 'Namibia', dial: '264', flag: '🇳🇦' },
  { code: 'MU', name: 'Mauricio', dial: '230', flag: '🇲🇺' },
  { code: 'SY', name: 'Siria', dial: '963', flag: '🇸🇾' },
  { code: 'OM', name: 'Omán', dial: '968', flag: '🇴🇲' },
  { code: 'BH', name: 'Baréin', dial: '973', flag: '🇧🇭' },
  { code: 'YE', name: 'Yemen', dial: '967', flag: '🇾🇪' },
];

function detectCountryFromPhone(phone: string): { country: Country; localNumber: string } | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  
  const sorted = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);
  for (const country of sorted) {
    if (digits.startsWith(country.dial)) {
      return { country, localNumber: digits.slice(country.dial.length) };
    }
  }
  return null;
}

interface CountryPhoneInputProps {
  value: string;
  onChange: (fullNumber: string) => void;
  disabled?: boolean;
  defaultCountryCode?: string;
  inputClassName?: string;
  selectorClassName?: string;
  searchInputClassName?: string;
  showPreview?: boolean;
}

export default function CountryPhoneInput({ value, onChange, disabled, defaultCountryCode, inputClassName, selectorClassName, searchInputClassName, showPreview }: CountryPhoneInputProps) {
  const [selectedCountry, setSelectedCountry] = useState<Country>(() => {
    if (defaultCountryCode) {
      return COUNTRIES.find(c => c.code === defaultCountryCode) || COUNTRIES[0];
    }
    return COUNTRIES[0];
  });
  const [localNumber, setLocalNumber] = useState('');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (value) {
      const cleanValue = value.startsWith('+') ? value.slice(1) : value;
      const detected = detectCountryFromPhone(cleanValue);
      if (detected) {
        setSelectedCountry(detected.country);
        setLocalNumber(detected.localNumber);
      }
    }
  }, []);

  useEffect(() => {
    if (defaultCountryCode && !localNumber) {
      const match = COUNTRIES.find(c => c.code === defaultCountryCode);
      if (match && match.code !== selectedCountry.code) {
        setSelectedCountry(match);
      }
    }
  }, [defaultCountryCode]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (isDropdownOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isDropdownOpen]);

  const filteredCountries = useMemo(() => {
    if (!search) return COUNTRIES;
    const q = search.toLowerCase();
    return COUNTRIES.filter(c => 
      c.name.toLowerCase().includes(q) || 
      c.dial.includes(q) ||
      c.code.toLowerCase().includes(q)
    );
  }, [search]);

  const handleLocalNumberChange = (val: string) => {
    const cleaned = val.replace(/[^\d\s\-]/g, '');
    setLocalNumber(cleaned);
    const digits = cleaned.replace(/\D/g, '');
    if (digits) {
      onChange('+' + selectedCountry.dial + digits);
    } else {
      onChange('');
    }
  };

  const handleCountrySelect = (country: Country) => {
    setSelectedCountry(country);
    setIsDropdownOpen(false);
    setSearch('');
    const digits = localNumber.replace(/\D/g, '');
    if (digits) {
      onChange('+' + country.dial + digits);
    }
  };

  const previewState = useMemo(() => {
    if (!showPreview) return null;
    const digits = localNumber.replace(/\D/g, '');
    if (!digits) return null;
    const candidate = '+' + selectedCountry.dial + digits;
    const result = normalizePhoneInput(candidate);
    if (result.ok) {
      const pretty = formatArgentineMobilePretty(result.phone);
      return { ok: true as const, text: `Se guardará como: ${pretty || result.phone}` };
    }
    if (selectedCountry.code === 'AR') {
      return { ok: false as const, text: 'Ingresá tu número local sin el 0 inicial.' };
    }
    return { ok: false as const, text: 'Verificá que el número sea válido.' };
  }, [showPreview, localNumber, selectedCountry]);

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
      <div className="relative" ref={dropdownRef}>
        <Button
          type="button"
          variant="outline"
          className={`w-[120px] justify-between px-2 h-10 text-sm ${selectorClassName || ''}`}
          onClick={() => !disabled && setIsDropdownOpen(!isDropdownOpen)}
          disabled={disabled}
          data-testid="button-country-selector"
        >
          <span className="flex items-center gap-1 truncate">
            <span className="text-base">{selectedCountry.flag}</span>
            <span>+{selectedCountry.dial}</span>
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </Button>
        
        {isDropdownOpen && (
          <div className="absolute top-full left-0 mt-1 w-72 bg-white dark:bg-gray-900 border rounded-lg shadow-lg z-50 overflow-hidden">
            <div className="p-2 border-b">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="Buscar país..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className={`w-full pl-7 pr-2 py-1.5 text-sm border rounded bg-transparent outline-none focus:ring-1 focus:ring-blue-500 ${searchInputClassName || ''}`}
                  data-testid="input-country-search"
                />
              </div>
            </div>
            <div className="max-h-60 overflow-y-auto">
              {filteredCountries.length === 0 ? (
                <div className="p-3 text-sm text-gray-500 text-center">No se encontró el país</div>
              ) : (
                filteredCountries.map((country) => (
                  <button
                    key={country.code}
                    type="button"
                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors ${
                      selectedCountry.code === country.code ? 'bg-blue-50 dark:bg-blue-900/30' : ''
                    }`}
                    onClick={() => handleCountrySelect(country)}
                    data-testid={`country-option-${country.code}`}
                  >
                    <span className="text-base">{country.flag}</span>
                    <span className="flex-1 text-left truncate">{country.name}</span>
                    <span className="text-gray-500 text-xs">+{country.dial}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
      
      <Input
        type="tel"
        placeholder={selectedCountry.code === 'AR' ? '11 6824-7426 (sin el 0 ni el 15)' : 'Número local'}
        value={localNumber}
        onChange={(e) => handleLocalNumberChange(e.target.value)}
        disabled={disabled}
        className={`flex-1 ${inputClassName || ''}`}
        data-testid="input-phone-local"
      />
      </div>
      {previewState && (
        <p
          className={`text-xs ${previewState.ok ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}`}
          data-testid="text-phone-preview"
        >
          {previewState.text}
        </p>
      )}
    </div>
  );
}

export { COUNTRIES, detectCountryFromPhone };
export type { Country };
