import { type ComponentPropsWithoutRef, type ElementRef, forwardRef, type HTMLAttributes, useRef } from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { IconBadge } from "./IconBadge"

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogClose = DialogPrimitive.Close

const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn("fixed inset-0 z-50 bg-ink/50 backdrop-blur-[2px] animate-fade-in", className)}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { widthClassName?: string }
>(({ className, widthClassName, children, onOpenAutoFocus, onCloseAutoFocus, ...props }, ref) => {
  // O Radix só devolve o foco ao fechar quando o diálogo foi aberto por um <DialogTrigger> — aqui TODOS são controlados
  // (`open` vem do estado da página; o botão da linha da tabela não é um Trigger) e o foco ia parar no <body>: quem usa
  // teclado ou leitor de tela perdia o lugar na tabela. Guardamos o elemento focado antes de abrir e o devolvemos ao fechar.
  const returnFocusTo = useRef<HTMLElement | null>(null)
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        onOpenAutoFocus={(event) => {
          returnFocusTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          onOpenAutoFocus?.(event)
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event)
          if (event.defaultPrevented) return
          event.preventDefault()
          const target = returnFocusTo.current
          if (target?.isConnected) target.focus()
        }}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-surface p-6 shadow-lg animate-scale-in sm:w-full",
          widthClassName ?? "sm:max-w-lg",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className="absolute right-4 top-4 rounded-lg p-1.5 text-ink-softer transition-colors hover:bg-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label="Fechar"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

/**
 * Cabeçalho do modal. `icon` reaproveita a linguagem visual do `PageHeader`
 * (selo com fundo tingido `bg-primary/10 text-primary` + `shadow-tinted-primary`)
 * só que menor — o modal não é o cabeçalho da página inteira. Fica de fora do
 * `DialogTitle` (que é o `Radix.Title`, texto puro) para não misturar o nome
 * acessível do diálogo com decoração.
 */
function DialogHeader({
  className,
  icon: Icon,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { icon?: LucideIcon }) {
  return (
    <div className={cn("mb-4 flex items-start gap-3 pr-8", className)} {...props}>
      {Icon && <IconBadge icon={Icon} size="md" tinted />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-lg font-bold text-ink", className)} {...props} />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("mt-1 text-sm text-ink-softer", className)} {...props} />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />
}

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
}
