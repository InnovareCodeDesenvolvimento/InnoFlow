#!/usr/bin/env node
/**
 * Abre (decifra), confere ou cifra um backup do InnoFlow. Só precisa de Node: não depende do projeto instalado
 * (nem de node_modules), de propósito. No dia do desastre o que existe é o arquivo, a chave e um Node.
 *
 *   node scripts/decrypt-backup.mjs <backup.dump.enc> --chave <arquivo> [--saida <backup.dump>]
 *   node scripts/decrypt-backup.mjs <backup.dump.enc> --chave <arquivo> --verificar   (decifra e descarta: só confere)
 *   node scripts/decrypt-backup.mjs <backup.dump.enc> --info                         (impressão digital da chave do arquivo)
 *   node scripts/decrypt-backup.mjs <backup.dump> --cifrar --chave <arquivo> [--saida <backup.dump.enc>]
 *
 * `--chave` aponta para um arquivo com a linha "CHAVE: <64 caracteres hexadecimais>" ou só com a chave. A chave
 * NUNCA vai por argumento (apareceria no `ps`); se preferir não ter arquivo, exporte BACKUP_KEY (a chave, ou a linha
 * "CHAVE: ...") e omita --chave.
 *
 * O resultado só ganha o nome final DEPOIS de a verificação de integridade passar: um arquivo adulterado, cortado ou
 * aberto com a chave errada não deixa nada para trás (o arquivo parcial é apagado). A chave errada e o arquivo
 * adulterado são detectados aqui, ANTES de qualquer coisa tocar num banco.
 *
 * FORMATO (versão 1), documentado em docs/BACKUP-FORMATO.md e implementado também no módulo de backup do backend
 * (os dois são testados um contra o outro: mudar um sem o outro quebra o teste):
 *   "INNOBKP" (7) | versão (1 byte) | impressão digital da chave (4 bytes) | IV (12) | AES-256-GCM em fluxo | tag (16)
 * A impressão digital é os 4 primeiros bytes de SHA-256(chave). O cabeçalho sem o IV (12 bytes) é dado autenticado (AAD).
 *
 * Códigos de saída: 0 ok, 1 erro de uso, 2 chave errada, 3 arquivo adulterado/cortado/não cifrado.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("INNOBKP", "latin1");
const VERSION = 1;
const FP_BYTES = 4;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD_BYTES = MAGIC.length + 1 + FP_BYTES;
const HEADER_BYTES = AAD_BYTES + IV_BYTES;

class CryptoError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

function fingerprintOf(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, FP_BYTES * 2);
}

function parseKey(text) {
  const clean = text.replace(/[\s-]/g, "");
  return /^[0-9a-fA-F]{64}$/.test(clean) ? Buffer.from(clean, "hex") : null;
}

function extractKey(text) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*chave\s*:\s*(.+)$/i);
    if (m) {
      const key = parseKey(m[1]);
      if (key) return key;
    }
  }
  return parseKey(text);
}

function createEncryptStream(key) {
  const iv = randomBytes(IV_BYTES);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), createHash("sha256").update(key).digest().subarray(0, FP_BYTES), iv]);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(header.subarray(0, AAD_BYTES));
  let started = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (!started) {
        this.push(header);
        started = true;
      }
      cb(null, cipher.update(chunk));
    },
    flush(cb) {
      if (!started) this.push(header);
      this.push(cipher.final());
      this.push(cipher.getAuthTag());
      cb();
    },
  });
}

function createDecryptStream(key) {
  const expected = fingerprintOf(key);
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let decipher = null;

  function open() {
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new CryptoError("Este arquivo não é um backup cifrado do InnoFlow (a marca do formato não bate). Se é um .dump comum, ele não precisa de chave.", 3);
    }
    const version = head[MAGIC.length];
    const fileFp = head.subarray(MAGIC.length + 1, AAD_BYTES).toString("hex");
    if (version !== VERSION) throw new CryptoError(`Este backup usa a versão ${version} do formato, e este script só abre a ${VERSION}. Use um script mais novo.`, 3);
    if (fileFp !== expected) {
      throw new CryptoError(`Chave errada: este backup foi cifrado com a chave de impressão digital ${fileFp}, e a chave informada é a ${expected}.`, 2);
    }
    decipher = createDecipheriv("aes-256-gcm", key, head.subarray(AAD_BYTES, HEADER_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(head.subarray(0, AAD_BYTES));
  }

  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        let data = chunk;
        if (!decipher) {
          head = Buffer.concat([head, chunk]);
          const probe = head.subarray(0, Math.min(head.length, MAGIC.length));
          if (!probe.equals(MAGIC.subarray(0, probe.length))) open();
          if (head.length < HEADER_BYTES) return cb();
          open();
          data = head.subarray(HEADER_BYTES);
          head = Buffer.alloc(0);
        }
        tail = Buffer.concat([tail, data]);
        if (tail.length > TAG_BYTES) {
          const release = tail.subarray(0, tail.length - TAG_BYTES);
          tail = tail.subarray(tail.length - TAG_BYTES);
          cb(null, decipher.update(release));
        } else {
          cb();
        }
      } catch (error) {
        cb(error);
      }
    },
    flush(cb) {
      try {
        if (!decipher) {
          const probe = head.subarray(0, Math.min(head.length, MAGIC.length));
          if (probe.length === 0 || !probe.equals(MAGIC.subarray(0, probe.length))) open();
          throw new CryptoError("O arquivo está cortado: termina antes do fim do cabeçalho.", 3);
        }
        if (tail.length < TAG_BYTES) throw new CryptoError("O arquivo está cortado: falta o final, onde fica a prova de integridade.", 3);
        decipher.setAuthTag(tail);
        let last;
        try {
          last = decipher.final();
        } catch {
          throw new CryptoError("Falha na verificação: o arquivo foi alterado, está corrompido ou está incompleto. Não use este backup.", 3);
        }
        cb(null, last);
      } catch (error) {
        cb(error);
      }
    },
  });
}

function readHeaderFingerprint(file) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = readSync(fd, buf, 0, HEADER_BYTES, 0);
    if (n < HEADER_BYTES || !buf.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    return buf.subarray(MAGIC.length + 1, AAD_BYTES).toString("hex");
  } finally {
    closeSync(fd);
  }
}

function fail(message, code = 1) {
  console.error(`ERRO: ${message}`);
  process.exit(code);
}

function usage() {
  console.error(
    [
      "Uso:",
      "  node scripts/decrypt-backup.mjs <backup.dump.enc> --chave <arquivo> [--saida <backup.dump>]",
      "  node scripts/decrypt-backup.mjs <backup.dump.enc> --chave <arquivo> --verificar",
      "  node scripts/decrypt-backup.mjs <backup.dump.enc> --info",
      "  node scripts/decrypt-backup.mjs <backup.dump> --cifrar --chave <arquivo> [--saida <backup.dump.enc>]",
      "A chave também pode vir da variável BACKUP_KEY (omita --chave).",
    ].join("\n"),
  );
  process.exit(1);
}

const args = process.argv.slice(2);
let input = null;
let keyFile = null;
let output = null;
let encrypt = false;
let info = false;
let verifyOnly = false;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === "--chave") keyFile = args[++i] ?? usage();
  else if (a === "--saida") output = args[++i] ?? usage();
  else if (a === "--cifrar") encrypt = true;
  else if (a === "--info") info = true;
  else if (a === "--verificar") verifyOnly = true;
  else if (a.startsWith("--")) usage();
  else if (input === null) input = a;
  else usage();
}
if (!input) usage();
if (encrypt && verifyOnly) usage();
if (verifyOnly && output) usage();
if (!existsSync(input) || !statSync(input).isFile()) fail(`arquivo não encontrado: ${input}`);

if (info) {
  const fp = readHeaderFingerprint(input);
  if (!fp) fail("este arquivo não é um backup cifrado do InnoFlow.", 3);
  console.log(`Backup cifrado do InnoFlow. Impressão digital da chave: ${fp}`);
  process.exit(0);
}

let key = null;
if (keyFile) {
  if (!existsSync(keyFile)) fail(`arquivo da chave não encontrado: ${keyFile}`);
  key = extractKey(readFileSync(keyFile, "utf8"));
  if (!key) fail("não achei uma chave válida no arquivo (esperava a linha CHAVE: com 64 caracteres hexadecimais).");
} else if (process.env.BACKUP_KEY) {
  key = extractKey(process.env.BACKUP_KEY);
  if (!key) fail("BACKUP_KEY não tem uma chave válida (64 caracteres hexadecimais).");
} else {
  fail("falta a chave. Use --chave <arquivo> (a linha CHAVE: com 64 caracteres hexadecimais) ou exporte BACKUP_KEY.");
}

if (verifyOnly) {
  try {
    let bytes = 0;
    const discard = new Writable({
      write(chunk, _enc, cb) {
        bytes += chunk.length;
        cb();
      },
    });
    await pipeline(createReadStream(input), createDecryptStream(key), discard);
    console.log(`Verificado: o arquivo abre com esta chave e está íntegro (${bytes} bytes decifrados; impressão digital da chave: ${fingerprintOf(key)})`);
    process.exit(0);
  } catch (error) {
    if (error instanceof CryptoError) fail(error.message, error.exitCode);
    fail(`não deu para processar o arquivo: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const finalPath = output ?? (encrypt ? `${input}.enc` : input.replace(/\.enc$/, "") === input ? `${input}.dump` : input.replace(/\.enc$/, ""));
if (existsSync(finalPath)) fail(`o arquivo de saída já existe e não vou sobrescrever: ${finalPath}`);
const partial = `${finalPath}.parcial-${process.pid}`;

try {
  await pipeline(createReadStream(input), encrypt ? createEncryptStream(key) : createDecryptStream(key), createWriteStream(partial, { mode: 0o600 }));
  renameSync(partial, finalPath);
  console.log(`${encrypt ? "Cifrado" : "Decifrado e verificado"}: ${finalPath} (impressão digital da chave: ${fingerprintOf(key)})`);
} catch (error) {
  rmSync(partial, { force: true });
  if (error instanceof CryptoError) fail(error.message, error.exitCode);
  fail(`não deu para processar o arquivo: ${error instanceof Error ? error.message : String(error)}`);
}
