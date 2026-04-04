"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutGrid,
  CalendarDays,
  PlusCircle,
  MessageSquare,
  Star,
  Settings,
  ChevronDown,
  Zap,
} from "lucide-react";
import { useState } from "react";

interface NavSection {
  label: string;
  items: { label: string; href: string; icon: React.ReactNode }[];
}

const sections: NavSection[] = [
  {
    label: "Content",
    items: [
      { label: "Review", href: "/review", icon: <LayoutGrid size={18} /> },
      { label: "Calendar", href: "/calendar", icon: <CalendarDays size={18} /> },
      { label: "New Post", href: "/new", icon: <PlusCircle size={18} /> },
    ],
  },
  {
    label: "Campaigns",
    items: [
      { label: "SMS Campaigns", href: "/campaigns", icon: <MessageSquare size={18} /> },
    ],
  },
  {
    label: "Reviews",
    items: [
      { label: "GBP Reviews", href: "/reviews", icon: <Star size={18} /> },
    ],
  },
  {
    label: "Settings",
    items: [
      { label: "Settings", href: "/settings", icon: <Settings size={18} /> },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  function toggle(label: string) {
    setCollapsed((prev) => ({ ...prev, [label]: !prev[label] }));
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-white">
      {/* Logo / App Name */}
      <div className="flex items-center gap-2.5 border-b border-zinc-200 px-5 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-aac-blue">
          <Zap size={16} className="text-white" />
        </div>
        <div>
          <p className="font-display text-sm font-bold text-aac-dark">
            Marketing Engine
          </p>
          <p className="text-[11px] text-zinc-400">Attack A Crack</p>
        </div>
      </div>

      {/* Nav Sections */}
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {sections.map((section) => (
          <div key={section.label} className="mb-4">
            <button
              onClick={() => toggle(section.label)}
              className="flex w-full items-center justify-between px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-600"
            >
              {section.label}
              <ChevronDown
                size={14}
                className={`transition-transform ${
                  collapsed[section.label] ? "-rotate-90" : ""
                }`}
              />
            </button>

            {!collapsed[section.label] && (
              <ul className="mt-1 space-y-0.5">
                {section.items.map((item) => {
                  const active = pathname === item.href;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                          active
                            ? "bg-aac-blue/10 font-semibold text-aac-blue"
                            : "text-zinc-600 hover:bg-zinc-100 hover:text-aac-dark"
                        }`}
                      >
                        {item.icon}
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}
      </nav>
    </aside>
  );
}
