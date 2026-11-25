import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLogColorSettings } from "../store/logColors";
import {
  HIGHLIGHT_CLASSES, HIGHLIGHT_COLORS, LEVEL_CLASSES, MAX_HIGHLIGHT_KEYWORD_LENGTH,
  MAX_HIGHLIGHT_RULES, type LogHighlightColor, type LogHighlightRule,
} from "../utils/logHighlight";

const COLOR_LABEL_CLASSES: Record<LogHighlightColor, string> = {
  red: "text-red-700 dark:text-red-300",
  amber: "text-amber-700 dark:text-amber-300",
  green: "text-emerald-700 dark:text-emerald-300",
  blue: "text-blue-700 dark:text-blue-300",
  purple: "text-violet-700 dark:text-violet-300",
};

function LogColorSelect({ value, label, onChange }: {
  value: LogHighlightColor;
  label: string;
  onChange: (color: LogHighlightColor) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [menu, setMenu] = useState<{ above: boolean; height: number } | null>(null);
  const [active, setActive] = useState(0);

  useLayoutEffect(() => {
    const options = list.current;
    const item = options?.children[active] as HTMLElement | undefined;
    if (!options || !item) return;
    if (item.offsetTop < options.scrollTop) options.scrollTop = item.offsetTop;
    const bottom = item.offsetTop + item.offsetHeight;
    if (bottom > options.scrollTop + options.clientHeight) options.scrollTop = bottom - options.clientHeight;
  }, [active, menu]);

  const open = () => {
    if (!button.current) return;
    button.current.focus({ preventScroll: true });
    const rect = button.current.getBoundingClientRect();
    const scrollArea = button.current.closest(".overflow-y-auto, main")?.getBoundingClientRect();
    const below = Math.min(window.innerHeight, scrollArea?.bottom ?? window.innerHeight) - rect.bottom;
    const above = rect.top - Math.max(0, scrollArea?.top ?? 0);
    const preferAbove = below < 168 && above > below;
    setActive(HIGHLIGHT_COLORS.indexOf(value));
    setMenu({ above: preferAbove, height: Math.max(28, (preferAbove ? above : below) - 6) });
  };

  const select = (color: LogHighlightColor) => {
    onChange(color);
    setMenu(null);
  };

  const handleKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const { key } = event;
    if (!menu && (key === "ArrowDown" || key === "ArrowUp")) {
      event.preventDefault();
      open();
      return;
    }
    if (!menu) return;
    const last = HIGHLIGHT_COLORS.length - 1;
    switch (key) {
      case "ArrowDown": setActive(Math.min(active + 1, last)); break;
      case "ArrowUp": setActive(Math.max(active - 1, 0)); break;
      case "Home": setActive(0); break;
      case "End": setActive(last); break;
      case "Enter":
      case " ": select(HIGHLIGHT_COLORS[active]); break;
      case "Escape": setMenu(null); break;
      default: return;
    }
    event.preventDefault();
  };

  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        role="combobox"
        aria-label={label}
        aria-controls={menu ? id : undefined}
        aria-expanded={!!menu}
        aria-activedescendant={menu ? `${id}-${active}` : undefined}
        onClick={() => menu ? setMenu(null) : open()}
        onKeyDown={handleKey}
        onBlur={() => setMenu(null)}
        className="ui-select flex min-w-20 items-center justify-between gap-1.5 whitespace-nowrap"
      >
        <span className={`font-medium ${COLOR_LABEL_CLASSES[value]}`}>{t(`multiLog.highlight.colors.${value}`)}</span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
      </button>
      {menu && (
        <ul
          ref={list}
          id={id}
          role="listbox"
          aria-label={label}
          onMouseDown={(event) => event.preventDefault()}
          style={{ maxHeight: menu.height }}
          className={`ui-card absolute right-0 z-20 min-w-full overflow-auto whitespace-nowrap py-1 text-xs ${menu.above ? "bottom-full mb-1" : "top-full mt-1"}`}
        >
          {HIGHLIGHT_COLORS.map((color, index) => (
            <li
              key={color}
              id={`${id}-${index}`}
              role="option"
              aria-selected={value === color}
              onMouseMove={() => setActive(index)}
              onClick={() => select(color)}
              className={`cursor-pointer px-2.5 py-1.5 font-medium ${COLOR_LABEL_CLASSES[color]} ${active === index ? "bg-slate-100 dark:bg-slate-800" : ""}`}
            >
              {t(`multiLog.highlight.colors.${color}`)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface RuleListProps {
  title: string;
  rules: LogHighlightRule[];
  onChange: (rules: LogHighlightRule[]) => void;
  children?: ReactNode;
}

export function LogColorRuleList({ title, rules, onChange, children }: RuleListProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const updateRule = (index: number, patch: Partial<LogHighlightRule>) =>
    onChange(rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule));

  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium" id={titleId}>{title}</h3>
        <button
          type="button"
          disabled={rules.length >= MAX_HIGHLIGHT_RULES}
          onClick={() => onChange([...rules, { keyword: "", color: "amber" }])}
          className="ui-btn-secondary px-2 py-1 text-xs"
        >
          {t("multiLog.highlight.add")}
        </button>
      </div>
      {children}
      {rules.map((rule, index) => (
        <div key={index} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
          <input
            value={rule.keyword}
            maxLength={MAX_HIGHLIGHT_KEYWORD_LENGTH}
            aria-label={t("multiLog.highlight.keyword", { number: index + 1 })}
            onChange={(event) => updateRule(index, { keyword: event.target.value })}
            className="ui-input min-w-0 font-mono"
          />
          <div className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`size-3 shrink-0 rounded-sm ${HIGHLIGHT_CLASSES[rule.color]}`} />
            <LogColorSelect
              value={rule.color}
              label={t("multiLog.highlight.color", { number: index + 1 })}
              onChange={(color) => updateRule(index, { color })}
            />
          </div>
          <button
            type="button"
            onClick={() => onChange(rules.filter((_, i) => i !== index))}
            className="ui-btn-secondary px-2 py-1"
          >
            {t("common.delete")}
          </button>
        </div>
      ))}
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {t("multiLog.highlight.hint", { maxRules: MAX_HIGHLIGHT_RULES, maxLength: MAX_HIGHLIGHT_KEYWORD_LENGTH })}
      </p>
    </section>
  );
}

export function LogColorSettings() {
  const { t } = useTranslation();
  const { rules, save } = useLogColorSettings();
  const [error, setError] = useState("");
  const title = t("multiLog.highlight.sharedTitle");

  const change = (next: LogHighlightRule[]) => {
    try {
      save(next);
      setError("");
    } catch (cause) {
      setError(String(cause));
    }
  };

  return (
    <section className="ui-card space-y-3 p-4 text-sm">
      <LogColorRuleList title={title} rules={rules} onChange={change}>
        <p className="text-xs text-slate-500 dark:text-slate-400">{t("multiLog.highlight.sharedHint")}</p>
      </LogColorRuleList>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-200 pt-3 text-xs dark:border-slate-800">
        <span className="font-medium">{t("multiLog.highlight.levelLegend")}</span>
        {Object.entries(LEVEL_CLASSES).map(([level, className]) => (
          <span key={level} className={`font-semibold ${className}`}>{t(`multiLog.highlight.levels.${level}`)}</span>
        ))}
      </div>
      {error && <div role="alert" className="ui-alert-err block break-words">{error}</div>}
    </section>
  );
}
