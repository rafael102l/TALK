export type LanguageCode = "he" | "en" | "hi" | "fr" | "ar" | "ru" | "es" | "de" | "pt" | "it" | "tr" | "uk" | "ka" | "am" | "zh" | "ja" | "ko" | "pl";
export type Language = {
    code: LanguageCode;
    nameHe: string;
    nameEn: string;
    rtl?: boolean;
    ttsSupported: boolean;
};
export declare const LANGUAGES: Language[];
export declare const LANGUAGE_BY_CODE: Record<LanguageCode, Language>;
export declare const DEFAULT_LANGUAGE: LanguageCode;
export declare function isLanguageCode(value: string): value is LanguageCode;
