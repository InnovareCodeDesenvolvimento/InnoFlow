-- Dados da empresa (controlador) cadastrados pelo painel ADMIN: razão social, nome fantasia, CNPJ, suporte, endereço, site, encarregado (DPO) e as VERSÕES vigentes
-- dos Termos/Privacidade. Tabela SINGLETON (id = 1), mesmo desenho de "NotificationChannelConfig": o painel manda, as envs LEGAL_* são a reserva. SEM segredos:
-- tudo aqui aparece na página pública (rodapé, termos, e-mails), então nada é cifrado.
-- Aditiva: só CREATE TABLE; não toca em nenhuma tabela existente.

CREATE TABLE "CompanyProfile" (
    "id" INTEGER NOT NULL DEFAULT 1,

    "legalName" TEXT,
    "tradeName" TEXT,
    "cnpj" VARCHAR(14),
    "supportEmail" TEXT,
    "supportPhone" TEXT,
    "address" TEXT,
    "website" TEXT,
    "dpoName" TEXT,
    "dpoEmail" TEXT,

    "termsVersion" VARCHAR(32),
    "privacyVersion" VARCHAR(32),

    "companyDataSavedAt" TIMESTAMPTZ(3),
    "updatedByUserId" TEXT,

    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CompanyProfile_pkey" PRIMARY KEY ("id")
);

-- Singleton de verdade (só a linha id = 1) e formato reforçado no banco, não só na aplicação (a API valida os dígitos verificadores).
-- CNPJ: 12 caracteres alfanuméricos maiúsculos + 2 dígitos verificadores (o CNPJ alfanumérico vale desde julho/2026; o numérico antigo é um caso particular).
ALTER TABLE "CompanyProfile"
  ADD CONSTRAINT "company_profile_singleton" CHECK ("id" = 1),
  ADD CONSTRAINT "company_profile_cnpj_format" CHECK ("cnpj" IS NULL OR "cnpj" ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  ADD CONSTRAINT "company_profile_terms_version_nonblank" CHECK ("termsVersion" IS NULL OR length(btrim("termsVersion")) > 0),
  ADD CONSTRAINT "company_profile_privacy_version_nonblank" CHECK ("privacyVersion" IS NULL OR length(btrim("privacyVersion")) > 0);

-- ============================================================
-- ROLLBACK MANUAL (não automático)
-- ============================================================
-- DROP TABLE IF EXISTS "CompanyProfile";
