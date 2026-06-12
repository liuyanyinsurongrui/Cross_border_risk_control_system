"use client"

import { useToast, type ToasterToast } from "@/hooks/use-toast"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

export function Toaster() {
  const { toasts, dismiss } = useToast()

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((t: ToasterToast) => (
        <div
          key={t.id}
          className={cn(
            "flex items-start gap-3 rounded-lg border px-4 py-3 shadow-lg transition-all animate-in slide-in-from-bottom-5",
            t.variant === "destructive"
              ? "border-red-500/20 bg-red-500/10 text-red-300"
              : "border-slate-700 bg-[#1a1d27] text-slate-200"
          )}
        >
          <div className="flex-1">
            {t.title && <p className="text-sm font-medium">{t.title}</p>}
            {t.description && (
              <p className={cn("text-xs", t.variant === "destructive" ? "text-red-400" : "text-slate-400")}>
                {t.description}
              </p>
            )}
          </div>
          <button
            onClick={() => dismiss(t.id)}
            className="shrink-0 text-slate-500 hover:text-slate-300"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
