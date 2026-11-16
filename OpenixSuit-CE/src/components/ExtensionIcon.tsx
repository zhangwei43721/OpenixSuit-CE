import {
  Activity,
  Bug,
  Code2,
  Cpu,
  Disc,
  Download,
  Flame,
  Folder,
  HardDrive,
  Layers,
  Package,
  Puzzle,
  RefreshCw,
  Rocket,
  Settings,
  Shield,
  Sliders,
  Smartphone,
  Terminal,
  Upload,
  Usb,
  Wrench,
  Zap,
} from "lucide-react";

interface ExtensionIconProps {
  icon?: string | null;
  className?: string;
}

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  activity: Activity,
  bug: Bug,
  code: Code2,
  cpu: Cpu,
  disc: Disc,
  download: Download,
  flame: Flame,
  folder: Folder,
  "hard-drive": HardDrive,
  layers: Layers,
  package: Package,
  puzzle: Puzzle,
  refresh: RefreshCw,
  rocket: Rocket,
  settings: Settings,
  shield: Shield,
  sliders: Sliders,
  smartphone: Smartphone,
  terminal: Terminal,
  upload: Upload,
  usb: Usb,
  wrench: Wrench,
  zap: Zap,
};

export function ExtensionIcon({ icon, className = "h-4 w-4 shrink-0" }: ExtensionIconProps) {
  const raw = icon?.trim();
  if (!raw) {
    return <Puzzle className={className} />;
  }

  if (raw.startsWith("data:image/") || raw.startsWith("http://") || raw.startsWith("https://")) {
    return <img src={raw} alt="" className={`${className} rounded-sm object-contain`} />;
  }

  const normalized = raw.toLowerCase().replace(/_/g, "-");
  const NamedIcon = ICON_MAP[normalized];
  if (NamedIcon) {
    return <NamedIcon className={className} />;
  }

  // Fallback for emoji or short custom character badges
  if ([...raw].length <= 3) {
    return (
      <span className={`${className} inline-flex items-center justify-center leading-none`}>
        {raw}
      </span>
    );
  }

  return <Puzzle className={className} />;
}
