import { Outlet } from "react-router-dom"
import { Header } from "./Header"
import { Footer } from "./Footer"

/** Casca das páginas públicas (header + rodapé). O painel admin tem casca própria (`pages/Admin/Layout.tsx`). */
export function Layout() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <a
        href="#conteudo"
        className="fixed left-3 -top-16 z-[100] rounded-lg bg-primary px-4 py-2 font-bold text-white shadow-lg transition-[top] duration-200 focus:top-3"
      >
        Pular para o conteúdo
      </a>
      <Header />
      <main id="conteudo" className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  )
}
