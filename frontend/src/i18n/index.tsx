import { createContext, useContext, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { translations } from './translations';

type Lang = 'en' | 'es';

interface LangContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
}

const LangContext = createContext<LangContextValue>({ lang: 'en', setLang: () => {} });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const stored = localStorage.getItem('lang');
    return (stored === 'en' || stored === 'es') ? stored : 'en';
  });

  const setLang = useCallback((l: Lang) => {
    localStorage.setItem('lang', l);
    setLangState(l);
  }, []);

  return <LangContext.Provider value={{ lang, setLang }}>{children}</LangContext.Provider>;
}

export function useLang() {
  return useContext(LangContext);
}

export function useT() {
  const { lang } = useLang();
  const t = useCallback((key: string, vars?: Record<string, string>): string => {
    const dict = translations[lang];
    let str = dict[key] ?? translations['en'][key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
      }
    }
    return str;
  }, [lang]);
  return t;
}
