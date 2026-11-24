import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import {
  createLogHighlighter, HIGHLIGHT_COLORS, MAX_HIGHLIGHT_KEYWORD_LENGTH, MAX_HIGHLIGHT_RULES,
  type LogHighlightRule,
} from "../utils/logHighlight";

const STORAGE_KEY = "openix_log_highlight_rules";
const EMPTY_RULES: LogHighlightRule[] = [];

function loadRules(): LogHighlightRule[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!Array.isArray(value)) return [];
    return value.filter((rule): rule is LogHighlightRule =>
      rule && typeof rule.keyword === "string" &&
      rule.keyword.length <= MAX_HIGHLIGHT_KEYWORD_LENGTH &&
      !/[\r\n\0]/.test(rule.keyword) &&
      HIGHLIGHT_COLORS.includes(rule.color)
    ).slice(0, MAX_HIGHLIGHT_RULES);
  } catch {
    return [];
  }
}

const LogColorsContext = createContext({
  rules: EMPTY_RULES,
  highlight: createLogHighlighter(EMPTY_RULES, "", false),
  save: (_rules: LogHighlightRule[]) => {},
});

export function LogColorProvider({ children }: { children: ReactNode }) {
  const [rules, setRules] = useState(loadRules);
  const save = useCallback((next: LogHighlightRule[]) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setRules(next);
  }, []);
  const value = useMemo(() => ({
    rules, save, highlight: createLogHighlighter(rules, "", false),
  }), [rules, save]);
  return <LogColorsContext.Provider value={value}>{children}</LogColorsContext.Provider>;
}

export function useLogColorSettings() {
  return useContext(LogColorsContext);
}

export function useLogColorRules() {
  return useLogColorSettings().rules;
}
