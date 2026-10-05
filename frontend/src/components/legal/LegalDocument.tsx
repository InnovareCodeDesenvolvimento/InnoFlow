import { Link } from "react-router-dom"
import { Building2, FileText, Info } from "lucide-react"
import { Alert } from "@/components/ui/Alert"
import { Skeleton } from "@/components/ui/Skeleton"
import { PageBand } from "@/components/layout/PageBand"
import { usePublicLegal } from "@/hooks/useLegal"
import { LEGAL_PATHS } from "@/lib/legalPaths"
import { companyRows, hasCompanyData } from "@/lib/legalCompany"
import type { LegalDocumentContent, LegalSection } from "@/content/legal"
import type { PublicLegalConfig } from "@/types/api"

/**
 * Só em dev/mock (`import.meta.env.DEV`; no build de produção o valor é `false` e os ramos saem do bundle): avisos INTERNOS de quem revisa o texto. Em produção a página mostra
 * somente o conteúdo e os dados da empresa que existirem - nunca um aviso de "não informado" nem texto inventado.
 */
const SHOW_INTERNAL_NOTES = import.meta.env.DEV

const LINK = "font-semibold text-primary underline underline-offset-2 hover:text-primary-700"

/** Bloco "Responsável": só as linhas que o dono já informou (vazio = a linha nem existe). Sem nenhum dado: some em produção; em dev mostra o aviso interno. */
function CompanyBlock({ company, loading, failed }: { company: PublicLegalConfig["company"] | undefined; loading: boolean; failed: boolean }) {
  if (loading) return <Skeleton className="mt-4 h-24 rounded-card" />
  const rows = company ? companyRows(company) : []
  if (!hasCompanyData(company)) {
    if (!SHOW_INTERNAL_NOTES) return null
    return (
      <Alert tone="warning" icon={Info} className="mt-4" role="note" data-testid="legal-company-missing">
        Aviso interno (só em dev/mock): {failed ? "não foi possível carregar os dados da empresa de /api/public/legal." : "dados da empresa ainda não informados (razão social, CNPJ, e-mail de suporte, encarregado/DPO). Em produção este bloco simplesmente não aparece."}
      </Alert>
    )
  }
  return (
    <div className="mt-4 rounded-card border border-border bg-muted/40 p-4 sm:p-5" data-testid="legal-company">
      <p className="flex items-center gap-2 text-sm font-bold text-ink">
        <Building2 className="h-4 w-4 text-primary" aria-hidden="true" />
        Responsável
      </p>
      <dl className="mt-3 grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-[max-content_1fr]">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="font-medium text-ink-softer">{row.label}</dt>
            <dd className="min-w-0 break-words text-ink">
              {row.href ? (
                <a href={row.href} className={LINK}>
                  {row.value}
                </a>
              ) : (
                row.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function Section({ section, legal }: { section: LegalSection; legal: ReturnType<typeof usePublicLegal> }) {
  return (
    <section aria-labelledby={`sec-${section.id}`} className="scroll-mt-24">
      <h2 id={`sec-${section.id}`} className="text-xl font-extrabold tracking-tight text-ink">
        {section.title}
      </h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-ink-soft">
        {section.paragraphs.map((p) => (
          <p key={p}>{p}</p>
        ))}
        {section.items && (
          <ul className="list-disc space-y-2 pl-5 marker:text-primary">
            {section.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
        {section.closing?.map((p) => <p key={p}>{p}</p>)}
      </div>
      {section.showCompany && <CompanyBlock company={legal.data?.company} loading={legal.isLoading} failed={legal.isError} />}
      {SHOW_INTERNAL_NOTES && section.reviewNote && (
        <Alert tone="muted" size="sm" className="mt-3" role="note">
          Nota para a revisão jurídica (só em dev/mock): {section.reviewNote}
        </Alert>
      )}
    </section>
  )
}

/**
 * Página de um documento legal (Termos de Uso ou Política de Privacidade), na casca clara pública (`Layout`): faixa-título escura de marca + miolo de LEITURA (coluna de
 * ~70 caracteres, tipografia de texto longo) com o índice "Neste documento" (trilho lateral colado a partir de `lg`; lista no topo no celular). O TEXTO vem de `content/legal/*`
 * (arquivos separados, para quem redige o definitivo editar sem tocar aqui); a versão vigente e os dados da empresa vêm de `GET /api/public/legal` (se falhar, a página continua
 * legível e só omite o que depende da resposta). Altura mínima de uma tela: o rodapé não é deslocado quando os dados da empresa chegam.
 */
export function LegalDocument({ doc }: { doc: LegalDocumentContent }) {
  const legal = usePublicLegal()
  const version = doc.id === "termos" ? legal.data?.termsVersion : legal.data?.privacyVersion
  const other = doc.id === "termos" ? { to: LEGAL_PATHS.privacidade, label: "Política de Privacidade" } : { to: LEGAL_PATHS.termos, label: "Termos de Uso" }

  return (
    <>
      <PageBand title={doc.title} description={doc.summary} />

      <div className="container-app min-h-[100svh] py-8 sm:py-10">
        <div className="grid gap-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-12">
          <nav aria-label="Neste documento" className="lg:sticky lg:top-24 lg:self-start">
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-ink-softer">
              <FileText className="h-3.5 w-3.5" aria-hidden="true" />
              Neste documento
            </p>
            <ol className="mt-3 space-y-0.5 border-l border-border">
              {doc.sections.map((s, i) => (
                <li key={s.id}>
                  <a href={`#sec-${s.id}`} className="-ml-px flex min-h-11 items-center border-l-2 border-transparent py-1 pl-3 text-sm font-medium text-ink-soft hover:border-primary hover:text-ink lg:min-h-9">
                    <span className="mr-2 tabular-nums text-ink-softer">{i + 1}.</span>
                    {s.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <article className="max-w-[44rem]">
            {/* Linha de versão com altura reservada: a resposta de /api/public/legal chega depois e não pode deslocar o texto. */}
            <p className="min-h-5 text-sm text-ink-softer" data-testid="legal-version">
              {version ? (
                <>
                  Versão <span className="font-semibold tabular-nums text-ink-soft">{version}</span>
                </>
              ) : null}
            </p>
            {SHOW_INTERNAL_NOTES && doc.status === "draft" && (
              <Alert tone="warning" icon={Info} className="mt-3" role="note" data-testid="legal-draft-note">
                Aviso interno (só em dev/mock): minuta estrutural, ainda sem a redação jurídica definitiva (Alexandria) nem a revisão do dono.
              </Alert>
            )}

            <div className="mt-6 space-y-9">
              {doc.sections.map((s) => (
                <Section key={s.id} section={s} legal={legal} />
              ))}
            </div>

            <p className="mt-10 border-t border-border pt-5 text-sm text-ink-softer">
              Leia também:{" "}
              <Link to={other.to} className={LINK}>
                {other.label}
              </Link>
              .
            </p>
          </article>
        </div>
      </div>
    </>
  )
}
