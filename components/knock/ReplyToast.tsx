"use client";

type Props = {
  title: string;
  description: string;
  onOpen: () => void;
};

export default function ReplyToast({ title, description, onOpen }: Props) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full min-w-[280px] max-w-sm flex-col gap-1 rounded-xl border border-emerald-500/35 bg-slate-950 px-4 py-3 text-left shadow-lg transition hover:border-emerald-400/50"
    >
      <span className="text-sm font-semibold text-emerald-100">{title}</span>
      <span className="text-xs leading-relaxed text-slate-300">{description}</span>
      <span className="text-[10px] font-medium uppercase tracking-wider text-cyan-400/90">
        Tap to view replies
      </span>
    </button>
  );
}
