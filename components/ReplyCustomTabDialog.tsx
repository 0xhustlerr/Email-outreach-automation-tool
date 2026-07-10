"use client";

import { useState } from "react";
import { TAB_ICON_PRESETS } from "@/lib/reply-custom-tabs";

type Props = {
  open: boolean;
  title: string;
  initialName?: string;
  initialIcon?: string;
  onClose: () => void;
  onSave: (name: string, icon: string) => void;
};

export default function ReplyCustomTabDialog({
  open,
  title,
  initialName = "",
  initialIcon = "💬",
  onClose,
  onSave,
}: Props) {
  const [name, setName] = useState(initialName);
  const [icon, setIcon] = useState(initialIcon);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-white/15 bg-slate-950 p-4 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h4 className="text-sm font-semibold text-slate-100">{title}</h4>
        <label className="mt-3 block text-[10px] uppercase tracking-wider text-slate-500">
          Tab name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/40"
          placeholder="e.g. Hot leads"
          autoFocus
        />
        <p className="mt-3 text-[10px] uppercase tracking-wider text-slate-500">
          Icon
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {TAB_ICON_PRESETS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => setIcon(e)}
              className={`flex h-9 w-9 items-center justify-center rounded-lg border text-lg transition ${
                icon === e
                  ? "border-cyan-400/50 bg-cyan-500/20"
                  : "border-white/10 bg-white/5 hover:bg-white/10"
              }`}
            >
              {e}
            </button>
          ))}
        </div>
        <input
          value={icon}
          onChange={(e) => setIcon(e.target.value.slice(0, 2))}
          maxLength={2}
          className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-center text-lg outline-none focus:border-cyan-400/40"
          aria-label="Custom emoji icon"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(name, icon)}
            className="rounded-lg border border-cyan-400/40 bg-cyan-500/20 px-4 py-1.5 text-xs font-semibold text-cyan-100"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
