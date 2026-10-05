import { Component, type ReactNode } from "react"

interface Props {
  /** Chamado uma vez quando algo dentro do tour lança (ex.: o chunk lazy não baixou numa aba aberta antes de um deploy). */
  onError: () => void
  children: ReactNode
}

/**
 * O tour é ENFEITE de boas-vindas: se o chunk dele não carregar (aba velha depois de um deploy: o arquivo com hash antigo some; ou rede caindo), o app NÃO pode ir para a tela de erro da rota.
 * Aqui o erro é engolido, o tour simplesmente não abre (`onError` fecha o estado do provider) e o resto do shell segue funcionando. Nada é gravado: na próxima visita ele tenta de novo.
 */
export class TourErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch() {
    this.props.onError()
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}
