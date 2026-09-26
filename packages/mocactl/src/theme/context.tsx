import { createContext, useContext } from 'react';
import { resolveTheme, type Theme } from './tokens.js';

const ThemeContext = createContext<Theme>(resolveTheme('system', {}, false));

export const ThemeProvider = ThemeContext.Provider;

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
