"use client";

import { AnimatePresence, motion } from "motion/react";

type Props = {
  count: number;
  onClick: () => void;
};

export default function NewRepliesAlert({ count, onClick }: Props) {
  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.button
          type="button"
          initial={{ opacity: 0, y: -12, scale: 0.92 }}
          animate={{
            opacity: 1,
            y: 0,
            scale: 1,
          }}
          exit={{ opacity: 0, y: -8, scale: 0.95 }}
          transition={{ type: "spring", stiffness: 420, damping: 28 }}
          onClick={onClick}
          className="group relative flex w-full items-center justify-center gap-3 overflow-hidden rounded-2xl border border-emerald-400/40 bg-emerald-500/15 px-5 py-3 text-left shadow-[0_0_32px_rgba(52,211,153,0.25)] transition hover:border-emerald-300/60 hover:bg-emerald-500/25"
        >
          <motion.span
            className="absolute inset-0 bg-gradient-to-r from-emerald-500/0 via-emerald-400/20 to-emerald-500/0"
            animate={{ x: ["-100%", "100%"] }}
            transition={{ duration: 2.2, repeat: Infinity, ease: "linear" }}
          />
          <motion.span
            className="relative flex h-10 min-w-10 items-center justify-center rounded-full border border-emerald-300/50 bg-emerald-500/30 font-mono text-lg font-bold text-emerald-100"
            animate={{ scale: [1, 1.08, 1] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
          >
            {count}
          </motion.span>
          <span className="relative flex flex-col">
            <span className="text-sm font-semibold text-emerald-100">
              {count === 1 ? "New reply" : "New replies"}
            </span>
            <span className="text-xs text-emerald-200/80">
              Tap to view contacts - each row dismisses separately
            </span>
          </span>
          <motion.span
            className="relative text-emerald-300/90"
            animate={{ x: [0, 4, 0] }}
            transition={{ duration: 1.2, repeat: Infinity }}
            aria-hidden
          >
            →
          </motion.span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}
